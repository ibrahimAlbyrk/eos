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
  const spawn: SpawnPtyHost = () => {
    let onData: (d: string) => void = () => {};
    let onExit: (c: number) => void = () => {};
    const host: FakeHost = {
      onData: (cb) => { onData = cb; },
      onExit: (cb) => { onExit = cb; },
      write: (d) => { host.writes.push(d); },
      resize: (c, r) => { host.resizes.push([c, r]); },
      kill: () => { host.killed = true; },
      emit: (d) => onData(d),
      fireExit: (c) => onExit(c),
      writes: [], resizes: [], killed: false,
    };
    hosts.push(host);
    return host;
  };
  const svc = new PtySessionService({ bus, defaultCwd: "/proj", spawn });
  return { svc, bus, published, hosts };
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const dataFrames = (p: { topic: EventBusTopic }[]) => p.filter((x) => x.topic === "pty:data");

describe("PtySessionService", () => {
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

  it("publishes the first output on the leading edge, then coalesces the trailing window", async () => {
    const { svc, published, hosts } = harness();
    const s = svc.create({ cols: 80, rows: 24 });
    hosts[0].emit("prompt$ "); // leading edge → on the bus with NO batch delay
    let frames = dataFrames(published);
    assert.equal(frames.length, 1, "first output publishes immediately");
    assert.deepEqual(frames[0].payload, { sessionId: s.sessionId, number: 1, seq: 1, data: "prompt$ " });

    hosts[0].emit("a"); // inside the window → buffered
    hosts[0].emit("b"); // inside the window → buffered
    assert.equal(dataFrames(published).length, 1, "sustained burst stays batched until the window closes");
    await wait(260);
    frames = dataFrames(published);
    assert.equal(frames.length, 2);
    assert.deepEqual(frames[1].payload, { sessionId: s.sessionId, number: 1, seq: 2, data: "ab" });

    // Buffer replays the flushed output through the current seq.
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

    assert.deepEqual(published.map((p) => p.topic), ["pty:data", "pty:data", "pty:exit"]);
    assert.deepEqual(published[0].payload, { sessionId: s.sessionId, number: 1, seq: 1, data: "x" });
    assert.deepEqual(published[1].payload, { sessionId: s.sessionId, number: 1, seq: 2, data: "y" });
    assert.deepEqual(published[2].payload, { sessionId: s.sessionId, number: 1, exitCode: 7 });

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
});
