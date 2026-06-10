// Converge loop. Sequential on purpose: later steps deploy what earlier
// steps build, and a deterministic order is the whole point. Exit contract:
// `true` only when every step verifies fresh after the run — "exit 0 means
// everything running is current".

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { BuildCtx, BuildStep } from "./BuildStep.ts";
import { applyRelaunch, deliverUi } from "./steps/app-relaunch.ts";

function acquireLock(lockPath: string): boolean {
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, "utf8").trim());
    if (pid && !isNaN(pid)) {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        // stale lock from a dead process — take it over
      }
    }
  }
  writeFileSync(lockPath, String(process.pid));
  return true;
}

function dirtyReason(step: BuildStep, current: string | null, desired: string, force: boolean): string | null {
  if (current === null) return step.missingReason ?? "missing stamp";
  if (current !== desired) return "stamp mismatch";
  return force ? "forced" : null;
}

export async function runBuild(ctx: BuildCtx, steps: BuildStep[]): Promise<boolean> {
  const lockPath = join(ctx.eosHome, "build.lock");
  if (!acquireLock(lockPath)) {
    ctx.log(`another eos build is running (${lockPath})`);
    return false;
  }
  const release = (): void => {
    try {
      rmSync(lockPath, { force: true });
    } catch {}
  };
  const onSigint = (): void => {
    release();
    process.exit(130);
  };
  process.on("SIGINT", onSigint);

  try {
    const applied = new Set<string>();
    for (const step of steps) {
      const desired = await step.desiredStamp(ctx);
      const current = await step.currentStamp(ctx);
      const reason = dirtyReason(step, current, desired, ctx.force);
      if (reason === null) {
        ctx.log(`✓ ${step.id} fresh`);
        continue;
      }
      if (ctx.dryRun) {
        applied.add(step.id);
        ctx.log(`● ${step.id} would be ${step.verb.done} (${reason})`);
        continue;
      }
      ctx.log(`● ${step.id} ${step.verb.run} (${reason})…`);
      const t0 = Date.now();
      try {
        await step.apply(ctx, desired);
      } catch (e) {
        ctx.log(`✗ ${step.id} FAILED: ${e instanceof Error ? e.message : String(e)}`);
        ctx.log("aborting — later steps skipped");
        return false;
      }
      // Recompute both sides: apply may rewrite its own inputs (lockfiles).
      if ((await step.currentStamp(ctx)) !== (await step.desiredStamp(ctx))) {
        ctx.log(`✗ ${step.id} did not converge after apply (stamp still differs)`);
        return false;
      }
      applied.add(step.id);
      ctx.log(`  ↳ ${step.verb.done} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }

    const plan = await deliverUi(ctx, { webApplied: applied.has("web"), appApplied: applied.has("app") });
    if (plan.action === "none") {
      ctx.log(`✓ app ${plan.reason}`);
    } else if (ctx.dryRun) {
      ctx.log(`● app would ${plan.action} (${plan.reason})`);
    } else {
      ctx.log(`● app ${plan.action === "relaunch" ? "relaunching" : "opening"} (${plan.reason})…`);
      try {
        await applyRelaunch(plan);
      } catch (e) {
        ctx.log(`✗ app relaunch FAILED: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
      ctx.log("  ↳ done");
    }

    if (!ctx.dryRun) {
      for (const step of steps) {
        if ((await step.currentStamp(ctx)) !== (await step.desiredStamp(ctx))) {
          ctx.log(`✗ final verify: ${step.id} is stale again (source changed during build?) — rerun eos build`);
          return false;
        }
      }
      ctx.log("all fresh — everything running is current");
    }
    return true;
  } finally {
    process.removeListener("SIGINT", onSigint);
    release();
  }
}
