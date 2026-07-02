// Pure variable-builder for the skeptical-judge prompt. The rubric prose + output
// contract live in the central prompt template (manager/prompts/loop/judge-rubric
// .prompt.md); this only shapes the goal + evidence bundle into the template's
// variables (criteria list, machine signals, diff, files, claim). The caller
// renders via the PromptRenderer port (passing RETRY for the reparse attempt).

import type { GoalSpec } from "../../../contracts/src/loop.ts";
import type { EvidenceBundle } from "../ports/EvidenceCollector.ts";
import type { VariableScope } from "./prompt.ts";

export const JUDGE_RUBRIC_TEMPLATE = "loop/judge-rubric";

const CLAIM_CAP = 4000;

export function buildJudgeVars(goal: GoalSpec, bundle: EvidenceBundle): VariableScope {
  const criteria = goal.criteria
    .map((c) => `- [${c.id}] ${c.text}   (verify: ${c.verify ?? "—"})`)
    .join("\n");

  const machineSignals = bundle.machineSignals.length === 0
    ? "(none)"
    : bundle.machineSignals
        .flatMap((s) => [`[${s.criterionId ?? "—"}] $ ${s.command}  ->  exit ${s.exitCode}`, s.output || "(no output)"])
        .join("\n");

  // Diff visibility (Fix 6d1): show the base the diff is measured against, and
  // tell the judge WHY a diff is empty — a worker with no worktree (nothing was
  // collected) vs a real worktree with no change against its base. Collapsing
  // both to "(none)" hid committed-work / no-worktree cases from the judge.
  const worktreeCollected = bundle.diffBase !== undefined;
  const diffBase = `base ${bundle.diffBase ?? "HEAD"}`;
  const diff = bundle.diff && bundle.diff.length > 0
    ? bundle.diff
    : worktreeCollected ? "(empty against base)" : "(no worktree — not collected)";

  // FILES is empty when there are none → the template's {{#if FILES}} drops the
  // whole "EVIDENCE — FILES" section.
  const files = bundle.files && bundle.files.length > 0
    ? bundle.files.map((f) => `=== ${f.path} ===\n${f.content}`).join("\n")
    : "";

  return {
    GOAL_SUMMARY: goal.summary,
    CRITERIA: criteria,
    MACHINE_SIGNALS: machineSignals,
    DIFF_BASE: diffBase,
    DIFF: diff,
    FILES: files,
    CLAIM: truncate(bundle.reportClaim ?? "(none)", CLAIM_CAP),
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n...[truncated]` : s;
}
