import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createNodeProcessRunner } from "../tools/NodeProcessRunner.ts";

// MJ2: background shells must be reaped (no orphaned children / unbounded registry
// growth) and honor a timeout. Uses real short-lived subprocesses (echo/sleep).

async function waitUntil(fn: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return false;
}

describe("NodeProcessRunner — background shell lifecycle (MJ2)", () => {
  it("reap(owner) kills + evicts only that session's shells", () => {
    const proc = createNodeProcessRunner();
    const a = proc.startBackground("sleep 30", { cwd: process.cwd(), owner: "wA" });
    const b = proc.startBackground("sleep 30", { cwd: process.cwd(), owner: "wB" });
    assert.ok(proc.readBackground(a), "shell A is tracked");
    assert.ok(proc.readBackground(b), "shell B is tracked");

    proc.reap("wA");
    assert.equal(proc.readBackground(a), null, "A was killed + evicted by reap(wA)");
    assert.ok(proc.readBackground(b), "B (different owner) survived the reap");

    proc.reap("wB"); // cleanup
    assert.equal(proc.readBackground(b), null, "B reaped");
  });

  it("evicts a completed shell after its output is drained (no unbounded growth)", async () => {
    const proc = createNodeProcessRunner();
    const id = proc.startBackground("echo hello-bg", { cwd: process.cwd() });
    let out = "";
    const done = await waitUntil(() => {
      const r = proc.readBackground(id);
      if (!r) return true; // already evicted (a prior read drained the completed shell)
      out += r.stdout;
      return r.running === false; // this read drained + evicted it
    });
    assert.ok(done, "the shell completed");
    assert.match(out, /hello-bg/, "the background output was delivered before eviction");
    assert.equal(proc.readBackground(id), null, "completed + drained shell is evicted from the registry");
  });

  it("honors timeoutMs for a background shell (no forever-running orphan)", async () => {
    const proc = createNodeProcessRunner();
    const id = proc.startBackground("sleep 30", { cwd: process.cwd(), timeoutMs: 150 });
    const killed = await waitUntil(() => proc.readBackground(id)?.running === false, 3000);
    assert.ok(killed, "the background shell was SIGKILLed by its timeout (not left running)");
  });

  it("killBackground kills + evicts the shell immediately", () => {
    const proc = createNodeProcessRunner();
    const id = proc.startBackground("sleep 30", { cwd: process.cwd() });
    assert.equal(proc.killBackground(id), true);
    assert.equal(proc.readBackground(id), null, "killed shell is evicted");
    assert.equal(proc.killBackground(id), false, "a second kill is a no-op (already gone)");
  });
});
