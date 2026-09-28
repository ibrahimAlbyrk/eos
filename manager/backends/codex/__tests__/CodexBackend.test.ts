import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCodexBackend, type CodexBackendDeps } from "../CodexBackend.ts";
import type { AgentEvent } from "../../../../contracts/src/canonical.ts";
import type { AgentLaunchSpec } from "../../../../core/src/ports/AgentBackend.ts";
import { fakeAppServer, type FakeAppServer } from "./fakeAppServer.ts";

const tick = () => new Promise((r) => setImmediate(r));

function setup(over: Partial<CodexBackendDeps> = {}) {
  const server = fakeAppServer({
    "thread/start": () => ({ thread: { id: "th1" }, model: "gpt-x" }),
    "thread/resume": (p) => ({ thread: { id: p.threadId }, model: "gpt-x" }),
  });
  const decisions: Array<{ toolName: string; input: Record<string, unknown> }> = [];
  let allow = true;
  const deps: CodexBackendDeps = {
    binary: "/bin/codex",
    policy: { decide: async (i) => { decisions.push({ toolName: i.toolName, input: i.input }); return { behavior: allow ? "allow" : "deny" }; } },
    env: () => ({ PATH: "/bin" }),
    mcpServersFor: () => ({ worker: { command: "node" } }),
    assembleInstructions: () => "EOS PROTOCOL",
    open: async () => server,
    ...over,
  };
  const events: AgentEvent[] = [];
  const exits: number[] = [];
  const backend = createCodexBackend(deps);
  const spec = (s: Partial<AgentLaunchSpec> = {}): AgentLaunchSpec => ({
    workerId: "w1", cwd: "/repo", model: "gpt-x", prompt: "", persistent: true, parentId: "p1", isOrchestrator: false, ...s,
  } as AgentLaunchSpec);
  const start = (s: Partial<AgentLaunchSpec> = {}) =>
    backend.start(spec(s), { onEvent: (e) => events.push(e), onExit: (c) => exits.push(c) });
  return { server, backend, events, exits, decisions, start, setAllow: (v: boolean) => { allow = v; } };
}

const sent = (server: FakeAppServer, method: string) => server.requests.filter((r) => r.method === method);

describe("CodexBackend", () => {
  it("describes a subscription lane with its own thread store", () => {
    const { backend } = setup();
    assert.equal(backend.descriptor.kind, "codex-cli");
    assert.equal(backend.descriptor.billing, "subscription");
    assert.equal(backend.descriptor.sessionStore, "codex-thread");
    assert.equal(backend.descriptor.enabled, true);
    const noCodex = createCodexBackend({ binary: null, policy: { decide: async () => ({ behavior: "deny" }) }, env: () => ({}), mcpServersFor: () => ({}) });
    assert.equal(noCodex.descriptor.enabled, false);
  });

  it("starts a gated, read-only thread with Eos's instructions + MCP servers, then reports its id", async () => {
    const t = setup();
    await t.start();
    const [start] = sent(t.server, "thread/start");
    assert.deepEqual(start.params, {
      model: "gpt-x", cwd: "/repo", approvalPolicy: "untrusted", sandbox: "read-only",
      developerInstructions: "EOS PROTOCOL", config: { mcp_servers: { worker: { command: "node" } } },
    });
    assert.deepEqual(t.events, [{ type: "session", phase: "started" }, { type: "session", phase: "ready", sessionId: "th1" }]);
  });

  it("drops a Claude model the composer carried over, letting Codex pick its default", async () => {
    const t = setup();
    await t.start({ model: "opus" });
    assert.equal("model" in sent(t.server, "thread/start")[0].params, false);
  });

  it("resumes a persisted thread, and starts fresh when that fails", async () => {
    const t = setup();
    await t.start({ backendOptions: { resume: "th-old" } } as Partial<AgentLaunchSpec>);
    assert.equal(sent(t.server, "thread/resume")[0].params.threadId, "th-old");
    assert.equal(sent(t.server, "thread/start").length, 0);

    const u = setup();
    u.server.handlers["thread/resume"] = () => { throw new Error("thread not found"); };
    await u.start({ backendOptions: { resume: "gone" } } as Partial<AgentLaunchSpec>);
    assert.equal(sent(u.server, "thread/start").length, 1);
  });

  it("the boot prompt starts the first turn", async () => {
    const t = setup();
    await t.start({ prompt: "do it", effort: "high" });
    await tick();
    assert.deepEqual(sent(t.server, "turn/start")[0].params, {
      threadId: "th1", input: [{ type: "text", text: "do it", text_elements: [] }], model: "gpt-x", effort: "high",
    });
  });

  it("maps the thread's notifications and ignores other threads'", async () => {
    const t = setup();
    await t.start();
    t.server.emit("turn/started", { threadId: "th1", turn: { id: "t1" } });
    t.server.emit("turn/started", { threadId: "other", turn: { id: "x" } });
    assert.deepEqual(t.events.at(-1), { type: "turn", phase: "started" });
    assert.equal(t.events.filter((e) => e.type === "turn").length, 1);
  });

  it("a message mid-turn steers the running turn; idle starts a new one", async () => {
    const t = setup();
    const s = await t.start();
    t.server.emit("turn/started", { threadId: "th1", turn: { id: "t1" } });
    await s.sendMessage("also this");
    assert.deepEqual(sent(t.server, "turn/steer")[0].params, { threadId: "th1", input: [{ type: "text", text: "also this", text_elements: [] }], expectedTurnId: "t1" });
    t.server.emit("turn/completed", { threadId: "th1", turn: { id: "t1", status: "completed" } });
    await s.sendMessage("next");
    await tick();
    assert.equal(sent(t.server, "turn/start").length, 1);
  });

  it("a turn Codex refuses to start settles as an error instead of hanging", async () => {
    const t = setup();
    t.server.handlers["turn/start"] = () => { throw new Error("not signed in"); };
    const s = await t.start();
    await s.sendMessage("hi");
    await tick();
    assert.deepEqual(t.events.at(-1), { type: "turn", phase: "error", reason: "not signed in" });
  });

  it("commands and file edits are decided by the Eos gateway", async () => {
    const t = setup();
    await t.start();
    const cmd = await t.server.serverRequest("item/commandExecution/requestApproval", { itemId: "c1", command: "npm test", reason: "run tests" });
    assert.deepEqual(cmd, { decision: "accept" });
    assert.deepEqual(t.decisions[0], { toolName: "Bash", input: { command: "npm test", description: "run tests" } });

    t.server.emit("item/started", { threadId: "th1", item: { id: "f1", type: "fileChange", changes: [{ path: "src/a.ts", kind: { type: "update" }, diff: "" }, { path: "src/b.ts", kind: { type: "add" }, diff: "" }] } });
    const patch = await t.server.serverRequest("item/fileChange/requestApproval", { itemId: "f1" });
    assert.deepEqual(patch, { decision: "accept" });
    assert.deepEqual(t.decisions.slice(1), [
      { toolName: "Edit", input: { file_path: "/repo/src/a.ts" } },
      { toolName: "Write", input: { file_path: "/repo/src/b.ts" } },
    ]);

    t.setAllow(false);
    assert.deepEqual(await t.server.serverRequest("item/commandExecution/requestApproval", { itemId: "c2", command: "rm -rf /" }), { decision: "decline" });
  });

  it("grants no extra sandbox permissions and answers no in-turn questions", async () => {
    const t = setup();
    await t.start();
    assert.deepEqual(await t.server.serverRequest("item/permissions/requestApproval", {}), { permissions: {}, scope: "turn" });
    assert.deepEqual(await t.server.serverRequest("item/tool/requestUserInput", {}), { answers: {} });
  });

  it("interrupt targets the running turn; setModel applies to the next turn", async () => {
    const t = setup();
    const s = await t.start();
    t.server.emit("turn/started", { threadId: "th1", turn: { id: "t9" } });
    await s.interrupt();
    assert.deepEqual(sent(t.server, "turn/interrupt")[0].params, { threadId: "th1", turnId: "t9" });
    assert.deepEqual(await s.setModel("gpt-y", "low"), { ok: true });
    assert.equal((await s.setModel("sonnet")).ok, false);
    t.server.emit("turn/completed", { threadId: "th1", turn: { id: "t9", status: "interrupted" } });
    await s.sendMessage("go");
    await tick();
    assert.deepEqual(sent(t.server, "turn/start")[0].params, { threadId: "th1", input: [{ type: "text", text: "go", text_elements: [] }], model: "gpt-y", effort: "low" });
  });

  it("/clear starts a fresh thread and reports its id", async () => {
    const t = setup();
    const s = await t.start();
    t.server.handlers["thread/start"] = () => ({ thread: { id: "th2" } });
    assert.deepEqual(await s.clearContext!(), { ok: true });
    assert.deepEqual(t.events.at(-1), { type: "session", phase: "ready", sessionId: "th2" });
  });

  it("stop closes the server and reports an interrupt exit; a crash reports exit 1 then ended", async () => {
    const t = setup();
    const s = await t.start();
    s.stop();
    assert.equal(t.server.closed, true);
    assert.deepEqual(t.exits, [143]);
    assert.equal(s.isAlive(), false);

    const u = setup();
    await u.start();
    u.server.crash(1);
    assert.deepEqual(u.exits, [1]);
    assert.deepEqual(u.events.at(-1), { type: "session", phase: "ended", outcome: "crashed" });
  });

  it("lists the plan's visible models, default first", async () => {
    const t = setup();
    t.server.handlers["model/list"] = () => ({ data: [
      { id: "a", model: "gpt-a" }, { id: "h", model: "gpt-hidden", hidden: true }, { id: "d", model: "gpt-default", isDefault: true },
    ] });
    assert.deepEqual(await t.backend.listModels!(), ["gpt-default", "gpt-a"]);
    assert.equal(t.server.closed, true);
  });
});
