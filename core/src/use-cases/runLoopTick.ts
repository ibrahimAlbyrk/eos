// runLoopTick — the goal gate. Called when a looped worker reaches IDLE with an
// empty queue and no pending peer (the daemon enforces that ordering). Loads the
// worker's active loop, checks its goal, and applies the precedence (first hit
// wins): goal-MET → release SUCCESS regardless of attempt count; only an UNMET
// goal is then subject to unverifiable-escalate → attempt-limit → no-progress →
// continue. Exhaust paths (limit, frozen/oscillation) forward the held report
// ANNOTATED with the reason; escalate paths (every unmet criterion unverifiable,
// or a stalled thrasher) forward it UNVERIFIED and PAUSE the loop (awaiting
// input) — never a pass; goal-met forwards it as-is; continue discards it (a
// rejected claim) and re-triggers. NO budget tier — the no-progress detector is
// the only net on an unbounded loop.

import {
  CHECK_ERROR_TEMPLATE, CONTINUATION_TEMPLATE, ESCALATION_TEMPLATE, EXHAUSTED_RELEASE_TEMPLATE, LOOP_COMPLETE_TEMPLATE, LOOP_EXHAUSTED_TEMPLATE,
  buildCheckErrorVars, buildContinuationVars, buildEscalationVars, buildExhaustedReleaseVars, buildLoopCompleteVars, buildLoopExhaustedVars,
} from "../domain/loop-feedback.ts";
import { detectNoProgress, outcomeKey } from "../domain/loop-progress.ts";
import type { LoopStateRepo, LoopAttempt } from "../ports/LoopStateRepo.ts";
import type { GoalCheckStrategy, GoalContext, CommandRunner } from "../ports/GoalCheckStrategy.ts";
import type { LoopProgressSink, LoopProgressUpdate } from "../ports/LoopProgressSink.ts";
import type { PromptRenderer } from "../ports/PromptRenderer.ts";
import type { Clock } from "../ports/Clock.ts";
import type { Logger } from "../ports/Logger.ts";

export interface RunLoopTickDeps {
  loops: LoopStateRepo;
  strategyFor(name: string): GoalCheckStrategy;
  dispatch(input: { workerId: string; text: string; origin: string; attempt?: number }): Promise<unknown>;
  // Forward the worker's held report to its parent as a worker_report (the
  // manager builds the envelope from the worker row — core can't). provenance
  // tells the manager whether the body is the worker's own held report ("agent")
  // or a daemon-synthesized terminal message ("system").
  releaseReport(input: { workerId: string; parentId: string; text: string; provenance: "agent" | "system" }): Promise<unknown>;
  // A stable hash of the worker's current change-set ("" when no source) — the
  // no-progress signal. Implemented in the manager over GitInfo. `cwd` is the
  // fallback dir for a worker with no isolated worktree.
  stateHash(input: { worktreeDir?: string; cwd?: string; forkBaseSha?: string }): Promise<string>;
  noProgressWindow: number;
  stopOnNoProgress: boolean;
  // Builds a per-tick memoizing command runner shared across the check's
  // strategies + collector (dedups hybrid's double-run of every verify). Optional:
  // absent → the strategies fall back to their own runShell.
  makeCommandRunner?: () => CommandRunner;
  renderer: PromptRenderer;
  // Live goal-check progress (optional — absent in tests that don't assert it).
  // runLoopTick reports started → (verifying|judging, via the strategy) → verdict.
  progress?: LoopProgressSink;
  clock: Clock;
  log: Logger;
}

export interface RunLoopTickInput {
  workerId: string;
  worktreeDir?: string;
  // The worker's checkout dir — the no-progress fallback when it has no worktree.
  cwd?: string;
  branch?: string;
  forkBaseSha?: string;
  lastReportText?: string;
}

export type LoopTickOutcome = "noop" | "released" | "continued" | "exhausted" | "escalated";

export async function runLoopTick(deps: RunLoopTickDeps, input: RunLoopTickInput): Promise<LoopTickOutcome> {
  const loop = deps.loops.findActiveByWorker(input.workerId);
  if (!loop) return "noop";
  // Paused on a human's answer (the worker reported needs-input): do not tick —
  // no re-trigger, no goal-check, no attempt burned. The loop resumes when the
  // orchestrator's reply reaches the worker and clears awaiting_input.
  if (loop.awaitingInput) return "noop";

  // Live progress: enrich every update with this tick's attempt/strategy (the
  // worker id is added by the manager sink). attempt is the human-facing pass
  // count being checked (attemptsMade), matching the loop card's "attempt N/M".
  const checkAttempt = loop.attempt + 1;
  const emit = (u: Omit<LoopProgressUpdate, "attempt" | "maxAttempts" | "strategy">): void =>
    deps.progress?.({ attempt: checkAttempt, maxAttempts: loop.maxAttempts, strategy: loop.strategy, ...u });

  const ctx: GoalContext = {
    workerId: input.workerId,
    worktreeDir: input.worktreeDir,
    // The worker's checkout dir — the verify/file cwd when it has no worktree.
    cwd: input.cwd,
    branch: input.branch,
    forkBaseSha: input.forkBaseSha,
    attempt: loop.attempt,
    // The worker's own terminal claim (the held report) is what the judge must
    // demote-and-verify; fall back to any caller-supplied text.
    lastReportText: loop.heldReport ?? input.lastReportText,
    // One memoizing runner per check → every strategy/collector shares it, so a
    // hybrid check runs each (cmd, cwd) exactly once instead of twice.
    runCommand: deps.makeCommandRunner?.(),
    progress: (u) => emit({ phase: u.phase, criterionId: u.criterionId }),
  };
  emit({ phase: "started" });
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
    emit({ phase: "verdict", met: true, outcome: "released", reason: verdict.reason });
    if (loop.parentId != null) {
      // A held report is the worker's own (agent); a synthesized completion is
      // the daemon speaking for a worker that just stopped (system).
      const provenance = loop.heldReport != null ? "agent" : "system";
      const text = loop.heldReport
        ?? deps.renderer.render(LOOP_COMPLETE_TEMPLATE, buildLoopCompleteVars(loop.goal, attemptsMade)).trim();
      await deps.releaseReport({ workerId: loop.workerId, parentId: loop.parentId, text, provenance });
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
    emit({ phase: "verdict", met: false, outcome: "exhausted", reason });
    if (loop.parentId != null) {
      // The exhausted-release wraps the worker's own held report (agent); the
      // synthesized "ended unmet" message is the daemon's own (system).
      const provenance = loop.heldReport != null ? "agent" : "system";
      const text = loop.heldReport != null
        ? deps.renderer.render(EXHAUSTED_RELEASE_TEMPLATE, buildExhaustedReleaseVars(loop.goal, verdict, reason, loop.heldReport)).trim()
        : deps.renderer.render(LOOP_EXHAUSTED_TEMPLATE, buildLoopExhaustedVars(loop.goal, verdict, reason, attemptsMade)).trim();
      await deps.releaseReport({ workerId: loop.workerId, parentId: loop.parentId, text, provenance });
      if (loop.heldReport != null) deps.loops.setHeldReport(loop.id, null);
    }
    deps.loops.setStatus(loop.id, "exhausted");
    deps.log.info("loop exhausted", { workerId: input.workerId, loopId: loop.id, reason });
    return "exhausted";
  };

  // Escalate an UNMET loop: pause + surface, NEVER a pass. Forwards the worker's
  // report to the parent wrapped as UNVERIFIED with a decision menu (amend /
  // accept-and-stop / reply-to-continue), then reuses the needs-input pause
  // semantics: awaiting_input blocks every tick (no re-trigger, no attempt
  // burned) until the orchestrator's next message reaches the worker. The ring
  // is reset so a resumed loop gets a fresh no-progress window.
  const escalate = async (reason: string): Promise<LoopTickOutcome> => {
    emit({ phase: "verdict", met: false, outcome: "escalated", reason });
    if (loop.parentId != null) {
      const provenance = loop.heldReport != null ? "agent" : "system";
      const report = loop.heldReport ?? "(the worker left no report)";
      const text = deps.renderer.render(ESCALATION_TEMPLATE, buildEscalationVars(loop.goal, verdict, reason, report)).trim();
      await deps.releaseReport({ workerId: loop.workerId, parentId: loop.parentId, text, provenance });
    }
    if (loop.heldReport != null) deps.loops.setHeldReport(loop.id, null);
    deps.loops.setAwaitingInput(loop.id, true);
    deps.loops.resetProgress(loop.id);
    deps.log.info("loop escalated", { workerId: input.workerId, loopId: loop.id, reason });
    return "escalated";
  };

  // (0) Indeterminate: the goal CHECK itself failed (evidence collection threw or
  // the judge stayed unparseable), NOT the work — met is always false here, so
  // (1) already skipped it. Keep the held report, burn no attempt, and re-arm the
  // worker with a NEUTRAL nudge (never "everything is unmet"). Two consecutive
  // infra failures exhaust the loop — the check is broken and can't self-heal.
  // Fail-closed throughout: indeterminate never releases.
  if (verdict.indeterminate) {
    const consecutive = loop.checkFailures + 1;
    if (consecutive >= 2) {
      return exhaust("goal check failing (judge/evidence infrastructure)");
    }
    deps.loops.setCheckFailures(loop.id, consecutive);
    emit({ phase: "verdict", met: false, outcome: "continued", reason: verdict.reason });
    await deps.dispatch({
      workerId: input.workerId,
      text: deps.renderer.render(CHECK_ERROR_TEMPLATE, buildCheckErrorVars(loop.goal)).trim(),
      origin: "loop",
    });
    deps.log.info("loop check indeterminate — re-armed", { workerId: input.workerId, loopId: loop.id, consecutive });
    return "continued";
  }
  // Any determinate verdict clears the infra-failure streak.
  if (loop.checkFailures > 0) deps.loops.setCheckFailures(loop.id, 0);

  // (2) Unverifiable: every unmet criterion is one NO collectible artifact could
  // ever prove (judge rule 8) → re-triggering is pointless, hand the decision to
  // the orchestrator on first occurrence. Slots BEFORE the attempt limit: an
  // unprovable goal deserves a decision, not an exhaustion.
  const unverifiableIds = new Set(verdict.criteria.filter((c) => !c.met && c.unverifiable).map((c) => c.id));
  if (verdict.unmet.length > 0 && verdict.unmet.every((id) => unverifiableIds.has(id))) {
    return escalate(`the gate cannot verify criteria [${verdict.unmet.join(", ")}] with the evidence it collects (verify outputs, change diff, criteria-named files)`);
  }

  // (3) Attempt limit — only an UNMET goal can be exhausted.
  const nextAttempt = loop.attempt + 1;
  if (loop.maxAttempts != null && nextAttempt > loop.maxAttempts) {
    return exhaust("the attempt limit was reached");
  }

  // (4) No-progress — compute the change-set hash once (for both the no-progress
  // check and the recorded attempt).
  const stateHash = await deps.stateHash({ worktreeDir: input.worktreeDir, cwd: input.cwd, forkBaseSha: input.forkBaseSha });
  const entry: LoopAttempt = { stateHash, outcomeHash: outcomeKey(verdict.unmet), unmetCount: verdict.unmet.length, reason: verdict.reason };

  // stateHash "" = no worktree/diff source → can't measure progress → skip.
  if (deps.stopOnNoProgress && stateHash !== "") {
    const ring = [...loop.progressRing, entry].slice(-deps.noProgressWindow);
    const reason = detectNoProgress(ring, deps.noProgressWindow);
    // A stalled thrasher escalates rather than exhausts: a legitimately hard
    // criterion can honestly need more than one window of attempts — pause for a
    // decision instead of guillotining real work. Frozen/oscillation exhaust as
    // before.
    if (reason === "stalled") {
      return escalate(`${deps.noProgressWindow} attempts changed the code but closed no criterion — amend the goal, stop the loop, or reply to continue`);
    }
    if (reason) {
      return exhaust(reason === "frozen"
        ? `no progress — the worker produced an identical change-set across the last ${deps.noProgressWindow} attempts`
        : "no progress — the worker is cycling between a few change-sets without closing criteria");
    }
  }

  // (5) Continue: the held report (if any) is a REJECTED completion claim —
  // discard it, record this attempt, and re-trigger.
  emit({ phase: "verdict", met: false, outcome: "continued", reason: verdict.reason });
  if (loop.heldReport != null) deps.loops.setHeldReport(loop.id, null);
  deps.loops.recordAttempt(loop.id, entry);
  await deps.dispatch({
    workerId: input.workerId,
    text: deps.renderer.render(CONTINUATION_TEMPLATE, buildContinuationVars(loop.goal, verdict, nextAttempt)).trim(),
    origin: "loop",
    attempt: nextAttempt,
  });
  deps.log.info("loop re-triggered", { workerId: input.workerId, loopId: loop.id, attempt: nextAttempt });
  return "continued";
}
