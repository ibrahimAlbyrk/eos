import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFakeAgentBackend } from "../backends/FakeAgentBackend.ts";
import type { AgentLaunchSpec } from "../../../core/src/ports/AgentBackend.ts";

// Conformance: any AgentBackend must honor this contract. The Fake is the
// reference; real adapters (ClaudeCliBackend, …) are checked against the same
// expectations.

function spec(overrides: Partial<AgentLaunchSpec> = {}): AgentLaunchSpec {
  return {
    workerId: "w1",
    cwd: "/tmp",
    model: "opus",
    prompt: "do the thing",
    persistent: false,
    parentId: null,
    isOrchestrator: false,
    ...overrides,
  };
}

describe("AgentBackend conformance — FakeAgentBackend", () => {
  it("start returns a session with handle + capabilities, and records the prompt", async () => {
    const be = createFakeAgentBackend();
    const s = await be.start(spec());
    assert.equal(s.workerId, "w1");
    assert.equal(s.handle.kind, "inproc");
    assert.equal(s.capabilities.interrupt, true);
    assert.ok(s.isAlive());
    assert.deepEqual(be.sessions.get("w1")?.messages, ["do the thing"]);
  });

  it("fires onSpawn with the handle", async () => {
    const be = createFakeAgentBackend();
    let handed: unknown = null;
    await be.start(spec(), { onSpawn: (h) => { handed = h; } });
    assert.deepEqual(handed, { kind: "inproc", ref: "w1" });
  });

  it("sendMessage records and returns ok", async () => {
    const be = createFakeAgentBackend();
    const s = await be.start(spec({ prompt: "" }));
    const r = await s.sendMessage("hello");
    assert.deepEqual(r, { ok: true, status: 200, body: { ok: true } });
    assert.deepEqual(be.sessions.get("w1")?.messages, ["hello"]);
  });

  it("attach reconstructs a working session from a handle", async () => {
    const be = createFakeAgentBackend();
    await be.start(spec({ prompt: "" }));
    const s2 = be.attach("w1", { kind: "http", port: 7500, pid: 123 });
    assert.equal(s2.handle.kind, "http");
    await s2.sendMessage("via attach");
    assert.deepEqual(be.sessions.get("w1")?.messages, ["via attach"]);
  });

  it("keystroke + interrupt are recorded", async () => {
    const be = createFakeAgentBackend();
    const s = await be.start(spec());
    await s.sendKeystroke("1");
    await s.interrupt();
    const rec = be.sessions.get("w1");
    assert.deepEqual(rec?.keystrokes, ["1"]);
    assert.equal(rec?.interrupts, 1);
  });

  it("stop flips isAlive to false (idempotent)", async () => {
    const be = createFakeAgentBackend();
    const s = await be.start(spec());
    s.stop();
    s.stop();
    assert.equal(s.isAlive(), false);
    assert.equal(be.sessions.get("w1")?.stopped, true);
  });

  it("exit() fires the onExit callback with the code and flips isAlive", async () => {
    const be = createFakeAgentBackend();
    let exitCode: number | null = -1;
    const s = await be.start(spec(), { onExit: (c) => { exitCode = c; } });
    be.exit("w1", 143);
    assert.equal(exitCode, 143);
    assert.equal(s.isAlive(), false);
  });
});
