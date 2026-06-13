import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BuildCtx, BuildStep } from "../BuildStep.ts";
import { runBuild } from "../engine.ts";

const homes: string[] = [];
function makeCtx(overrides: Partial<BuildCtx> = {}): BuildCtx {
  const home = mkdtempSync(join(tmpdir(), "eos-engine-"));
  homes.push(home);
  return {
    repoRoot: home,
    daemonUrl: "http://127.0.0.1:0",
    eosHome: home,
    pidFile: join(home, "daemon.pid"),
    force: false,
    dryRun: false,
    // noApp keeps the relaunch epilogue inert so tests never touch pgrep/osascript.
    noApp: true,
    noRelaunch: false,
    open: false,
    log: () => {},
    ...overrides,
  };
}
after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

interface FakeStep extends BuildStep {
  applies: number;
  desired: string;
  current: string | null;
}

function fakeStep(id: string, opts: { desired?: string; current?: string | null; onApply?: (s: FakeStep) => void } = {}): FakeStep {
  const step: FakeStep = {
    id,
    verb: { run: "applying", done: "applied" },
    applies: 0,
    desired: opts.desired ?? "stamp-1",
    current: opts.current === undefined ? null : opts.current,
    desiredStamp() {
      return this.desired;
    },
    currentStamp() {
      return this.current;
    },
    async apply() {
      this.applies++;
      if (opts.onApply) opts.onApply(this);
      else this.current = this.desired;
    },
  };
  return step;
}

describe("runBuild", () => {
  it("skips fresh steps and applies dirty ones", async () => {
    const fresh = fakeStep("fresh", { desired: "s", current: "s" });
    const dirty = fakeStep("dirty", { desired: "s", current: "old" });
    const missing = fakeStep("missing", { desired: "s", current: null });
    assert.equal(await runBuild(makeCtx(), [fresh, dirty, missing]), true);
    assert.equal(fresh.applies, 0);
    assert.equal(dirty.applies, 1);
    assert.equal(missing.applies, 1);
  });

  it("converges when apply rewrites its own inputs (lockfile case)", async () => {
    const step = fakeStep("deps", {
      desired: "before",
      current: null,
      onApply(s) {
        s.desired = "after-lock-rewrite";
        s.current = "after-lock-rewrite";
      },
    });
    assert.equal(await runBuild(makeCtx(), [step]), true);
  });

  it("fails and skips later steps when an apply throws", async () => {
    const boom = fakeStep("boom", {
      onApply() {
        throw new Error("build exploded");
      },
    });
    const later = fakeStep("later");
    assert.equal(await runBuild(makeCtx(), [boom, later]), false);
    assert.equal(later.applies, 0);
  });

  it("catches an apply that does not actually converge", async () => {
    const liar = fakeStep("liar", {
      onApply() {
        /* leaves current stale */
      },
    });
    assert.equal(await runBuild(makeCtx(), [liar]), false);
  });

  it("--force applies even fresh steps", async () => {
    const fresh = fakeStep("fresh", { desired: "s", current: "s" });
    assert.equal(await runBuild(makeCtx({ force: true }), [fresh]), true);
    assert.equal(fresh.applies, 1);
  });

  it("--dry-run applies nothing and succeeds", async () => {
    const dirty = fakeStep("dirty");
    assert.equal(await runBuild(makeCtx({ dryRun: true }), [dirty]), true);
    assert.equal(dirty.applies, 0);
  });

  it("final verify catches cross-step staleness", async () => {
    const a = fakeStep("a", { desired: "s", current: "s" });
    const b = fakeStep("b", {
      onApply(s) {
        s.current = s.desired;
        a.current = "broken-by-b";
      },
    });
    assert.equal(await runBuild(makeCtx(), [a, b]), false);
  });

  it("refuses to run when another live build holds the lock", async () => {
    const ctx = makeCtx();
    writeFileSync(join(ctx.eosHome, "build.lock"), String(process.pid));
    const step = fakeStep("any");
    assert.equal(await runBuild(ctx, [step]), false);
    assert.equal(step.applies, 0);
  });

  it("takes over a stale lock from a dead pid", async () => {
    const ctx = makeCtx();
    writeFileSync(join(ctx.eosHome, "build.lock"), "999999");
    assert.equal(await runBuild(ctx, [fakeStep("any")]), true);
  });
});
