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

  it("frees a completed shell's buffers once drained, then re-polls benignly (N1)", async () => {
    const proc = createNodeProcessRunner();
    const id = proc.startBackground("echo hello-bg", { cwd: process.cwd() });
    let out = "";
    const done = await waitUntil(() => {
      const r = proc.readBackground(id);
      if (!r) return false;
      out += r.stdout;
      return r.running === false; // this read drained the completed shell
    });
    assert.ok(done, "the shell completed");
    assert.match(out, /hello-bg/, "the background output was delivered on the draining read");
    // N1: a redundant re-poll of a known-but-drained shell returns a benign
    // completed/empty result (BashOutput parity), NOT null / an error.
    const repoll = proc.readBackground(id);
    assert.ok(repoll, "a drained shell is still known (re-poll is not an unknown-shell miss)");
    assert.equal(repoll!.running, false, "re-poll reports completed");
    assert.equal(repoll!.stdout, "", "re-poll has no new output (buffer drained)");
    assert.equal(repoll!.stderr, "", "re-poll has no new stderr");
  });

  it("re-poll of a genuinely-unknown shell id is still a miss (null)", () => {
    const proc = createNodeProcessRunner();
    assert.equal(proc.readBackground("bash_does_not_exist"), null);
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

  it("reap group-kills a detached descendant, not just the /bin/sh (N2)", async () => {
    const proc = createNodeProcessRunner();
    // The shell backgrounds a long-lived grandchild and prints its PID, then exits
    // immediately — so a PID-only reap would leave the grandchild orphaned/alive.
    const id = proc.startBackground("sleep 30 & echo $!", { cwd: process.cwd(), owner: "wG" });
    let childPid = 0;
    await waitUntil(() => {
      const r = proc.readBackground(id);
      const m = r?.stdout.match(/(\d+)/);
      if (m) { childPid = Number(m[1]); return true; }
      return false;
    });
    assert.ok(childPid > 0, "captured the backgrounded grandchild pid");
    assert.doesNotThrow(() => process.kill(childPid, 0), "grandchild is alive before reap");

    proc.reap("wG");

    const dead = await waitUntil(() => {
      try { process.kill(childPid, 0); return false; } catch { return true; }
    }, 3000);
    assert.ok(dead, "the detached grandchild was killed by the process-group reap");
  });
});
