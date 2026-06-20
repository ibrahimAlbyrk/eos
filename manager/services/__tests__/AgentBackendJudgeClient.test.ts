import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentBackendJudgeClient } from "../AgentBackendJudgeClient.ts";
import type { AgentBackend, AgentLaunchSpec, AgentSession, BackendDescriptor } from "../../../core/src/ports/AgentBackend.ts";
import type { AgentEvent } from "../../../contracts/src/canonical.ts";

const noopLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLog; } };
const fakeAuth = (scheme: "oauth" | "apikey" | "none") => ({ resolve: async () => ({ scheme }) });

function fakeBackend(descriptorOver: Partial<BackendDescriptor> = {}) {
  let recordedSpec: AgentLaunchSpec | null = null;
  let stopped = false;
  const backend = {
    kind: "claude-sdk",
    descriptor: { kind: "claude-sdk", processModel: "in-process", enabled: true, ...descriptorOver } as BackendDescriptor,
    start: async (spec: AgentLaunchSpec, cb?: { onEvent?: (e: AgentEvent) => void }) => {
      recordedSpec = spec;
      const session = { workerId: spec.workerId, stop: () => { stopped = true; }, isAlive: () => true } as unknown as AgentSession;
      // Fire events on the next macrotask so the caller has assigned `session`
      // (mirrors the real backend: events stream after start() returns).
      setTimeout(() => {
        cb?.onEvent?.({ type: "message", role: "assistant", blocks: [{ type: "text", text: "VERDICT-TEXT" }] } as AgentEvent);
        cb?.onEvent?.({ type: "turn", phase: "ended" } as AgentEvent);
      }, 0);
      return session;
    },
    attach: () => ({}) as AgentSession,
  } as unknown as AgentBackend;
  return { backend, spec: () => recordedSpec, stopped: () => stopped };
}

function client(b: ReturnType<typeof fakeBackend>, auth = fakeAuth("oauth")) {
  return new AgentBackendJudgeClient({ backend: b.backend, auth, newId: () => "judge-1", cwd: "/repo", defaultModel: "sonnet", log: noopLog });
}

describe("AgentBackendJudgeClient", () => {
  it("rides the rubric on spec.prompt, returns the final assistant text, stops the session after turn:ended", async () => {
    const b = fakeBackend();
    const out = await client(b).judge("RUBRIC + EVIDENCE");
    assert.equal(out, "VERDICT-TEXT");
    assert.equal(b.spec()?.prompt, "RUBRIC + EVIDENCE");
    assert.equal(b.spec()?.persistent, false);
    assert.equal(b.spec()?.model, "sonnet");      // default model
    assert.equal(b.stopped(), true);
  });

  it("opts.model overrides the default", async () => {
    const b = fakeBackend();
    await client(b).judge("x", { model: "opus" });
    assert.equal(b.spec()?.model, "opus");
  });

  it("host chosen by CAPABILITY: a disabled lane is rejected", async () => {
    const b = fakeBackend({ enabled: false });
    await assert.rejects(() => client(b).judge("x"), /not an enabled in-process lane/);
  });

  it("host chosen by CAPABILITY: an out-of-process lane is rejected", async () => {
    const b = fakeBackend({ processModel: "out-of-process" });
    await assert.rejects(() => client(b).judge("x"), /not an enabled in-process lane/);
  });

  it("no subscription credential → unavailable (fail closed upstream)", async () => {
    const b = fakeBackend();
    await assert.rejects(() => client(b, fakeAuth("none")).judge("x"), /no subscription credential/);
  });
});
