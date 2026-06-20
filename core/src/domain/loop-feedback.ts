// Pure variable-builder for the worker re-trigger directive. The prose lives in
// the central prompt template (manager/prompts/loop/continuation.prompt.md);
// this only shapes the data (the failing-criteria list + attempt) into the
// template's variables. The caller renders via the PromptRenderer port.

import type { GoalSpec, GoalVerdict } from "../../../contracts/src/loop.ts";
import type { VariableScope } from "./prompt.ts";

export const CONTINUATION_TEMPLATE = "loop/continuation";
export const EXHAUSTED_RELEASE_TEMPLATE = "loop/exhausted-release";
// Synthesized terminal messages — sent when a loop ends but the worker left no
// held report (it "just stopped"), so the orchestrator is never left silent.
export const LOOP_COMPLETE_TEMPLATE = "loop/loop-complete";
export const LOOP_EXHAUSTED_TEMPLATE = "loop/loop-exhausted";

// The failing criteria, one per line, with the evidence of why — falls back to
// the bare unmet ids if the verdict carried no per-criterion rows.
function unmetList(goal: GoalSpec, verdict: GoalVerdict): string {
  const textById = new Map(goal.criteria.map((c) => [c.id, c.text]));
  const lines = verdict.criteria
    .filter((c) => !c.met)
    .map((c) => `- ${textById.get(c.id) ?? c.id}${c.evidence ? ` — ${c.evidence}` : ""}`);
  return lines.length > 0 ? lines.join("\n") : verdict.unmet.map((id) => `- ${id}`).join("\n");
}

export function buildContinuationVars(goal: GoalSpec, verdict: GoalVerdict, attempt: number): VariableScope {
  return { GOAL_SUMMARY: goal.summary, UNMET: unmetList(goal, verdict), ATTEMPT: String(attempt) };
}

// Vars for the annotation wrapping a looped worker's final report when its loop
// ended (attempt limit or no-progress) without ever meeting the goal. `reason`
// is the human phrase explaining which limit fired.
export function buildExhaustedReleaseVars(goal: GoalSpec, verdict: GoalVerdict, reason: string, report: string): VariableScope {
  return { GOAL_SUMMARY: goal.summary, REASON: reason, UNMET: unmetList(goal, verdict), REPORT: report };
}

// Vars for the SYNTHESIZED terminal messages (no held report to forward).
export function buildLoopCompleteVars(goal: GoalSpec, attempts: number): VariableScope {
  return { GOAL_SUMMARY: goal.summary, ATTEMPTS: String(attempts) };
}

export function buildLoopExhaustedVars(goal: GoalSpec, verdict: GoalVerdict, reason: string, attempts: number): VariableScope {
  return { REASON: reason, ATTEMPTS: String(attempts), UNMET: unmetList(goal, verdict) };
}
