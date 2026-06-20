// runLoopTick — the goal gate. Called when a looped worker reaches IDLE with an
// empty queue and no pending peer (the daemon enforces that ordering). Loads the
// worker's active loop, checks its goal, and applies the precedence (first hit
// wins): goal-MET → release SUCCESS regardless of attempt count; only an UNMET
// goal is then subject to attempt-limit → no-progress → continue. Exhaust paths
// (limit or no-progress) forward the held report ANNOTATED with the reason;
// goal-met forwards it as-is; continue discards it (a rejected claim) and
// re-triggers. NO budget tier — the no-progress detector is the only net on an
// unbounded loop.

import {
  CONTINUATION_TEMPLATE, EXHAUSTED_RELEASE_TEMPLATE, LOOP_COMPLETE_TEMPLATE, LOOP_EXHAUSTED_TEMPLATE,
  buildContinuationVars, buildExhaustedReleaseVars, buildLoopCompleteVars, buildLoopExhaustedVars,
} from "../domain/loop-feedback.ts";
import { detectNoProgress, outcomeKey } from "../domain/loop-progress.ts";
import type { LoopStateRepo, LoopAttempt } from "../ports/LoopStateRepo.ts";
import type { GoalCheckStrategy, GoalContext } from "../ports/GoalCheckStrategy.ts";
import type { PromptRenderer } from "../ports/PromptRenderer.ts";
import type { Clock } from "../ports/Clock.ts";
import type { Logger } from "../ports/Logger.ts";

export interface RunLoopTickDeps {
  loops: LoopStateRepo;
  strategyFor(name: string): GoalCheckStrategy;
  dispatch(input: { workerId: string; text: string; origin: string }): Promise<unknown>;
  // Forward the worker's held report to its parent as a worker_report (the
  // manager builds the wrapper + envelope from the worker row — core can't).
  releaseReport(input: { workerId: string; parentId: string; text: string }): Promise<unknown>;
  // A stable hash of the worker's current change-set ("" when no source) — the
  // no-progress signal. Implemented in the manager over GitInfo.
  stateHash(input: { worktreeDir?: string; forkBaseSha?: string }): Promise<string>;
  noProgressWindow: number;
  stopOnNoProgress: boolean;
  renderer: PromptRenderer;
  clock: Clock;
  log: Logger;
}

export interface RunLoopTickInput {
  workerId: string;
  worktreeDir?: string;
  branch?: string;
  forkBaseSha?: string;
  lastReportText?: string;
}

export type LoopTickOutcome = "noop" | "released" | "continued" | "exhausted";

export async function runLoopTick(deps: RunLoopTickDeps, input: RunLoopTickInput): Promise<LoopTickOutcome> {
  const loop = deps.loops.findActiveByWorker(input.workerId);
  if (!loop) return "noop";

  const ctx: GoalContext = {
    workerId: input.workerId,
    worktreeDir: input.worktreeDir,
    branch: input.branch,
    forkBaseSha: input.forkBaseSha,
    attempt: loop.attempt,
    // The worker's own terminal claim (the held report) is what the judge must
    // demote-and-verify; fall back to any caller-supplied text.
    lastReportText: loop.heldReport ?? input.lastReportText,
  };
  const verdict = await deps.strategyFor(loop.strategy).evaluate(loop.goal, ctx);

  // The number of work passes the worker has made (the initial report + the
  // re-triggers so far) — for the synthesized terminal messages.
  const attemptsMade = loop.attempt + 1;

  // (1) Goal MET wins outright — release SUCCESS regardless of attempt count. A
  // goal met on the final allowed attempt is a success, never an exhaustion. The
  // orchestrator ALWAYS gets a terminal signal: the worker's held report if it
  // left one, else a synthesized completion (a worker that "just stops" still
  // surfaces).
  if (verdict.met) {
    if (loop.parentId != null) {
      const text = loop.heldReport
        ?? deps.renderer.render(LOOP_COMPLETE_TEMPLATE, buildLoopCompleteVars(loop.goal, attemptsMade)).trim();
      await deps.releaseReport({ workerId: loop.workerId, parentId: loop.parentId, text });
      if (loop.heldReport != null) deps.loops.setHeldReport(loop.id, null);
    }
    deps.loops.setStatus(loop.id, "passed");
    deps.log.info("loop goal met", { workerId: input.workerId, loopId: loop.id, synthesized: loop.heldReport == null });
    return "released";
  }

  // Terminate an UNMET loop: forward the held report annotated with the reason,
  // or a synthesized "ended unmet" message when there is none — never leave the
  // orchestrator silent.
  const exhaust = async (reason: string): Promise<LoopTickOutcome> => {
    if (loop.parentId != null) {
      const text = loop.heldReport != null
        ? deps.renderer.render(EXHAUSTED_RELEASE_TEMPLATE, buildExhaustedReleaseVars(loop.goal, verdict, reason, loop.heldReport)).trim()
        : deps.renderer.render(LOOP_EXHAUSTED_TEMPLATE, buildLoopExhaustedVars(loop.goal, verdict, reason, attemptsMade)).trim();
      await deps.releaseReport({ workerId: loop.workerId, parentId: loop.parentId, text });
      if (loop.heldReport != null) deps.loops.setHeldReport(loop.id, null);
    }
    deps.loops.setStatus(loop.id, "exhausted");
    deps.log.info("loop exhausted", { workerId: input.workerId, loopId: loop.id, reason });
    return "exhausted";
  };

  // (2) Attempt limit — only an UNMET goal can be exhausted.
  const nextAttempt = loop.attempt + 1;
  if (loop.maxAttempts != null && nextAttempt > loop.maxAttempts) {
    return exhaust("the attempt limit was reached");
  }

  // (3) No-progress — compute the change-set hash once (for both the no-progress
  // check and the recorded attempt).
  const stateHash = await deps.stateHash({ worktreeDir: input.worktreeDir, forkBaseSha: input.forkBaseSha });
  const entry: LoopAttempt = { stateHash, outcomeHash: outcomeKey(verdict.unmet), unmetCount: verdict.unmet.length, reason: verdict.reason };

  // stateHash "" = no worktree/diff source → can't measure progress → skip.
  if (deps.stopOnNoProgress && stateHash !== "") {
    const ring = [...loop.progressRing, entry].slice(-deps.noProgressWindow);
    const reason = detectNoProgress(ring.map((e) => ({ stateHash: e.stateHash, unmetCount: e.unmetCount })), deps.noProgressWindow);
    if (reason) {
      return exhaust(reason === "frozen"
        ? `no progress — the worker produced an identical change-set across the last ${deps.noProgressWindow} attempts`
        : "no progress — the worker is cycling between a few change-sets without closing criteria");
    }
  }

  // (4) Continue: the held report (if any) is a REJECTED completion claim —
  // discard it, record this attempt, and re-trigger.
  if (loop.heldReport != null) deps.loops.setHeldReport(loop.id, null);
  deps.loops.recordAttempt(loop.id, entry);
  await deps.dispatch({
    workerId: input.workerId,
    text: deps.renderer.render(CONTINUATION_TEMPLATE, buildContinuationVars(loop.goal, verdict, nextAttempt)).trim(),
    origin: "loop",
  });
  deps.log.info("loop re-triggered", { workerId: input.workerId, loopId: loop.id, attempt: nextAttempt });
  return "continued";
}
