import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { EventBus, EventBusMessage, EventBusTopic } from "../../../core/src/ports/EventBus.ts";
import type { PtyHost, SpawnPtyHost } from "../../../spawner/pty-host.ts";
import { PtySessionService, PtyCapError } from "../PtySessionService.ts";

interface FakeHost extends PtyHost {
  emit(data: string): void;
  fireExit(code: number): void;
  writes: string[];
  resizes: Array<[number, number]>;
  killed: boolean;
}

function harness() {
  const published: { topic: EventBusTopic; payload: Record<string, unknown> }[] = [];
  const bus: EventBus = {
    publish(topic: EventBusTopic, payload: unknown): void {
      published.push({ topic, payload: payload as Record<string, unknown> });
    },
    subscribe(_t: EventBusTopic | "*", _fn: (m: EventBusMessage) => void): () => void { return () => {}; },
  };
  const hosts: FakeHost[] = [];
  const spawnOpts: Parameters<SpawnPtyHost>[0][] = [];
  const spawn: SpawnPtyHost = (opts) => {
    spawnOpts.push(opts);
    let onData: (d: string) => void = () => {};
    let onExit: (c: number) => void = () => {};
    const host: FakeHost = {
      onData: (cb) => { onData = cb; },
      onExit: (cb) => { onExit = cb; },
      write: (d) => { host.writes.push(d); },
      resize: (c, r) => { host.resizes.push([c, r]); },
      kill: () => { host.killed = true; },
      foreground: () => "claude",
      emit: (d) => onData(d),
      fireExit: (c) => onExit(c),
      writes: [], resizes: [], killed: false,
    };
    hosts.push(host);
    return host;
  };
  const sleeps: number[] = [];
  const sleep = async (ms: number): Promise<void> => { sleeps.push(ms); };
  const svc = new PtySessionService({ bus, defaultCwd: "/proj", spawn, sleep });
  return { svc, bus, published, hosts, spawnOpts, sleeps };
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const dataFrames = (p: { topic: EventBusTopic }[]) => p.filter((x) => x.topic === "pty:data");

describe("PtySessionService", () => {
  it("passes an optional startup command through to the host", () => {
    const { svc, spawnOpts } = harness();
    svc.create({ cols: 80, rows: 24, cwd: "/w", command: "claude --model opus" });
    svc.create({ cols: 80, rows: 24 });
    assert.equal(spawnOpts[0].command, "claude --model opus");
    assert.equal(spawnOpts[0].cwd, "/w");
    assert.equal(spawnOpts[1].command, undefined);
  });

  it("assigns a monotonic tab number at create and never reuses it", () => {
    const { svc, hosts } = harness();
    const a = svc.create({ cols: 80, rows: 24 });
    const b = svc.create({ cols: 80, rows: 24 });
    assert.equal(a.number, 1);
    assert.equal(b.number, 2);
    // Kill+exit tab 1, then create again — the next number is 3, not a reuse of 1.
    svc.kill(a.sessionId);
    hosts[0].fireExit(0);
    const c = svc.create({ cols: 80, rows: 24 });
    assert.equal(c.number, 3);
  });

  it("create returns the public session shape with the requested dims + default cwd", () => {
    const { svc } = harness();
    const s = svc.create({ cols: 100, rows: 40 });
    assert.equal(s.cwd, "/proj");
    assert.equal(s.cols, 100);
    assert.equal(s.rows, 40);
    assert.equal(s.alive, true);
    assert.equal(typeof s.sessionId, "string");
  });

  it("honors an explicit cwd override", () => {
    const { svc } = harness();
    const s = svc.create({ cols: 80, rows: 24, cwd: "/other" });
    assert.equal(s.cwd, "/other");
  });

  it("publishes the first output on the leading edge, then coalesces the trailing window within one frame", async () => {
    const { svc, published, hosts } = harness();
    const s = svc.create({ cols: 80, rows: 24 });
    hosts[0].emit("prompt$ "); // leading edge → on the bus with NO batch delay
    let frames = dataFrames(published);
    assert.equal(frames.length, 1, "first output publishes immediately");
    assert.deepEqual(frames[0].payload, { sessionId: s.sessionId, number: 1, seq: 1, data: "prompt$ " });

    hosts[0].emit("a"); // inside the window → buffered
    hosts[0].emit("b"); // inside the window → buffered
    assert.equal(dataFrames(published).length, 1, "sustained burst stays batched until the window closes");

    // Echo latency bound: the window is ~16ms, so the coalesced frame lands well
    // under the old 200ms — a 50ms wait would NOT have drained a 200ms window,
    // pinning the regression. (Generous vs 16ms to absorb CI timer jitter.)
    await wait(50);
    frames = dataFrames(published);
    assert.equal(frames.length, 2, "trailing burst drains within one frame, not 200ms");
    assert.deepEqual(frames[1].payload, { sessionId: s.sessionId, number: 1, seq: 2, data: "ab" });

    // Buffer replays the flushed output through the current seq (unchanged semantics).
    assert.deepEqual(svc.buffer(s.sessionId), { seq: 2, data: "prompt$ ab" });
  });

  it("input writes raw bytes to the host", () => {
    const { svc, hosts } = harness();
    const s = svc.create({ cols: 80, rows: 24 });
    assert.equal(svc.input(s.sessionId, "ls\r"), true);
    assert.deepEqual(hosts[0].writes, ["ls\r"]);
  });

  it("resize forwards to the host and updates the stored dims", () => {
    const { svc, hosts } = harness();
    const s = svc.create({ cols: 80, rows: 24 });
    assert.equal(svc.resize(s.sessionId, 120, 30), true);
    assert.deepEqual(hosts[0].resizes, [[120, 30]]);
    assert.deepEqual(svc.list().map((x) => [x.cols, x.rows]), [[120, 30]]);
  });

  it("kill signals the host", () => {
    const { svc, hosts } = harness();
    const s = svc.create({ cols: 80, rows: 24 });
    assert.equal(svc.kill(s.sessionId), true);
    assert.equal(hosts[0].killed, true);
  });

  it("onExit drains window-buffered output ahead of the exit frame, then drops the session", () => {
    const { svc, published, hosts } = harness();
    const s = svc.create({ cols: 80, rows: 24 });
    hosts[0].emit("x"); // leading edge → published immediately (seq 1)
    hosts[0].emit("y"); // arrives inside the window → buffered, not yet flushed
    hosts[0].fireExit(7); // exit drains "y" (seq 2) before the exit frame

    const frames = published.filter((p) => p.topic !== "pty:session");
    assert.deepEqual(frames.map((p) => p.topic), ["pty:data", "pty:data", "pty:exit"]);
    assert.deepEqual(frames[0].payload, { sessionId: s.sessionId, number: 1, seq: 1, data: "x" });
    assert.deepEqual(frames[1].payload, { sessionId: s.sessionId, number: 1, seq: 2, data: "y" });
    assert.deepEqual(frames[2].payload, { sessionId: s.sessionId, number: 1, exitCode: 7 });

    // Session is gone: buffer/list/input all report absence.
    assert.equal(svc.buffer(s.sessionId), null);
    assert.deepEqual(svc.list(), []);
    assert.equal(svc.input(s.sessionId, "x"), false);
  });

  it("resets tab numbering to 1 once the registry empties, but not while a tab remains", () => {
    const { svc, hosts } = harness();
    svc.create({ cols: 80, rows: 24 }); // 1
    const b = svc.create({ cols: 80, rows: 24 }); // 2
    assert.equal(b.number, 2);
    hosts[0].fireExit(0); // tab 1 gone, tab 2 still open → NO reset
    assert.equal(svc.create({ cols: 80, rows: 24 }).number, 3); // no reuse while non-empty
    hosts[1].fireExit(0); // tab 2 gone
    hosts[2].fireExit(0); // tab 3 gone → registry empty → reset
    assert.deepEqual(svc.list(), []);
    assert.equal(svc.create({ cols: 80, rows: 24 }).number, 1); // reopened from zero → Terminal 1
  });

  it("keeps climbing while tabs remain and only resets when all close (operator scenario)", () => {
    const { svc, hosts } = harness();
    for (let i = 0; i < 27; i++) svc.create({ cols: 80, rows: 24 }); // numbers 1..27
    assert.equal(svc.create({ cols: 80, rows: 24 }).number, 28);
    for (const h of hosts) h.fireExit(0); // close all 28
    assert.deepEqual(svc.list(), []);
    assert.equal(svc.create({ cols: 80, rows: 24 }).number, 1);
  });

  it("unknown session ids return absence, not throws", () => {
    const { svc } = harness();
    assert.equal(svc.input("nope", "x"), false);
    assert.equal(svc.resize("nope", 80, 24), false);
    assert.equal(svc.buffer("nope"), null);
    assert.equal(svc.kill("nope"), false);
  });

  it("caps concurrent sessions at 32", () => {
    const { svc } = harness();
    for (let i = 0; i < 32; i++) svc.create({ cols: 80, rows: 24 });
    assert.throws(() => svc.create({ cols: 80, rows: 24 }), PtyCapError);
    assert.equal(svc.list().length, 32);
  });

  it("launches Claude itself for a claude session and announces it", () => {
    const { svc, spawnOpts, published } = harness();
    const s = svc.create({ cols: 80, rows: 24, claude: {}, remote: true });
    assert.equal(s.kind, "claude");
    assert.ok(s.claudeSessionId);
    assert.equal(s.remote, true);
    assert.ok(spawnOpts[0].command?.includes(`--session-id ${s.claudeSessionId}`));
    assert.deepEqual(published.filter((p) => p.topic === "pty:session").map((p) => p.payload), [s]);
    assert.equal(svc.create({ cols: 80, rows: 24 }).kind, "shell");
  });

  it("follows the pane's title and Claude conversation from its output", () => {
    const { svc, hosts, published } = harness();
    const s = svc.create({ cols: 80, rows: 24, claude: {} });
    const next = "123e4567-e89b-42d3-a456-426614174000";
    hosts[0].emit("\x1b]0;⠂ Fix login\x07");
    hosts[0].emit("\x1b]0;✳ Fix login\x07"); // spinner frame only — no change
    hosts[0].emit(`\x1b]7777;eos-claude-session=${next}\x07`);
    const updates = published.filter((p) => p.topic === "pty:session").slice(1).map((p) => p.payload);
    assert.deepEqual(updates.map((u) => [u.title, u.claudeSessionId]), [["Fix login", s.claudeSessionId], ["Fix login", next]]);
    assert.equal(svc.get(s.sessionId)?.claudeSessionId, next);
  });

  it("remembers the dialog tool call the pane reports and announces a conversation change", () => {
    const { svc, hosts, published } = harness();
    const s = svc.create({ cols: 80, rows: 24, claude: {} });
    const hook = { tool_name: "ExitPlanMode", tool_use_id: "p1", tool_input: { plan: "x" } };
    hosts[0].emit(`\x1b]7777;eos-claude-tool=${Buffer.from(JSON.stringify(hook)).toString("base64")}\x07`);
    assert.deepEqual(svc.dialogCall(s.sessionId), { toolUseId: "p1", name: "ExitPlanMode", input: { plan: "x" }, at: svc.dialogCall(s.sessionId)?.at });
    assert.deepEqual(published.filter((p) => p.topic === "pty:conversation").map((p) => p.payload), [{ sessionId: s.sessionId, claudeSessionId: s.claudeSessionId }]);
  });

  it("announces a real resize so mirrors redraw at the new grid", () => {
    const { svc, published } = harness();
    const s = svc.create({ cols: 80, rows: 24 });
    svc.resize(s.sessionId, 80, 24);
    svc.resize(s.sessionId, 100, 30);
    const sizes = published.filter((p) => p.topic === "pty:session").map((p) => [p.payload.cols, p.payload.rows]);
    assert.deepEqual(sizes, [[80, 24], [100, 30]]);
  });

  it("writes steps one at a time, in order, never interleaving two sequences", async () => {
    const { svc, hosts, sleeps } = harness();
    const s = svc.create({ cols: 80, rows: 24 });
    const a = svc.sendSteps(s.sessionId, ["\x1b[200~hi\x1b[201~", "\r"]);
    const b = svc.sendSteps(s.sessionId, ["1", "2"]);
    assert.deepEqual(await Promise.all([a, b]), [true, true]);
    assert.deepEqual(hosts[0].writes, ["\x1b[200~hi\x1b[201~", "\r", "1", "2"]);
    assert.deepEqual(sleeps, [300, 150, 150, 150]);
    assert.equal(await svc.sendSteps("nope", ["x"]), false);
  });
});
