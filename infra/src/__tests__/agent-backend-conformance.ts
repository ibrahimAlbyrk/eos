// Shared AgentBackend contract conformance. Every adapter (Fake, InProcess,
// ClaudeCli, ClaudeSdk) must satisfy these universal invariants — the net each
// new backend is checked against. Backend-specific behavior (canonical event
// sequences, billing, capability values) lives in each adapter's own test.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentBackend, AgentLaunchSpec, WorkerHandle } from "../../../core/src/ports/AgentBackend.ts";

export interface ConformanceOpts {
  /** Await an async start/turn before asserting (InProcess). No-op by default. */
  settle?(be: AgentBackend, workerId: string): Promise<void>;
  /** Expected handle.kind, when the backend pins one. */
  expectHandleKind?: WorkerHandle["kind"];
  /** Trigger session exit for the onExit invariant; omit to skip that check. */
  triggerExit?(be: AgentBackend, workerId: string): void;
}

function baseSpec(overrides: Partial<AgentLaunchSpec> = {}): AgentLaunchSpec {
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

export function runAgentBackendConformance(
  name: string,
  makeBackend: () => AgentBackend,
  opts: ConformanceOpts = {},
): void {
  const settle = opts.settle ?? (async () => {});
  describe(`AgentBackend shared-conformance — ${name}`, () => {
    it("start returns a session (handle + capabilities + isAlive) and fires onSpawn", async () => {
      const be = makeBackend();
      let handed: WorkerHandle | null = null;
      const s = await be.start(baseSpec(), { onSpawn: (h) => { handed = h; } });
      await settle(be, "w1");
      assert.equal(s.workerId, "w1");
      assert.ok(s.handle, "session exposes a handle");
      if (opts.expectHandleKind) assert.equal(s.handle.kind, opts.expectHandleKind);
      assert.equal(typeof s.capabilities.interrupt, "boolean");
      assert.equal(typeof s.capabilities.keystroke, "boolean");
      assert.ok(handed, "onSpawn fired with a handle");
      assert.ok(s.isAlive());
    });

    it("sendMessage resolves to an ok-shaped result", async () => {
      const be = makeBackend();
      const s = await be.start(baseSpec({ prompt: "" }));
      await settle(be, "w1");
      const r = await s.sendMessage("hello");
      assert.equal(typeof r.ok, "boolean");
      assert.ok(r.ok);
      await settle(be, "w1");
    });

    it("attach reconstructs an alive session for the same worker", async () => {
      const be = makeBackend();
      const s1 = await be.start(baseSpec({ prompt: "" }));
      await settle(be, "w1");
      const s2 = be.attach("w1", s1.handle);
      assert.equal(s2.workerId, "w1");
      assert.ok(s2.isAlive());
    });

    it("stop is idempotent and flips isAlive to false", async () => {
      const be = makeBackend();
      const s = await be.start(baseSpec({ prompt: "" }));
      await settle(be, "w1");
      s.stop();
      s.stop();
      assert.equal(s.isAlive(), false);
    });

    if (opts.triggerExit) {
      it("fires onExit when the session ends", async () => {
        const be = makeBackend();
        let exited = false;
        await be.start(baseSpec({ prompt: "" }), { onExit: () => { exited = true; } });
        await settle(be, "w1");
        opts.triggerExit!(be, "w1");
        assert.ok(exited, "onExit fired");
      });
    }
  });
}
