// Equivalence guard: the centralized loop templates, rendered with the core
// var-builders, must reproduce the EXACT prompt text the P1–P3 inline builders
// produced. The goldens below are the captured output of the original
// buildContinuation / buildJudgePrompt. Any drift in rubric or continuation
// meaning fails here.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { PromptService } from "../../../core/src/services/PromptService.ts";
import { PromptRegistry } from "../../../core/src/services/PromptRegistry.ts";
import { FilePromptSource } from "../../../infra/src/prompt/FilePromptSource.ts";
import { CONTINUATION_TEMPLATE, EXHAUSTED_RELEASE_TEMPLATE, buildContinuationVars, buildExhaustedReleaseVars } from "../../../core/src/domain/loop-feedback.ts";
import { JUDGE_RUBRIC_TEMPLATE, buildJudgeVars } from "../../../core/src/domain/judge-rubric.ts";
import type { GoalSpec, GoalVerdict } from "../../../contracts/src/loop.ts";
import type { EvidenceBundle } from "../../../core/src/ports/EvidenceCollector.ts";

const noopLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLog; } };
const promptsDir = join(import.meta.dirname, "..", "..", "prompts");
const prompts = new PromptService(new PromptRegistry(new FilePromptSource([promptsDir]), noopLog as never));
const render = (id: string, vars: Record<string, unknown>): string => prompts.render(id, vars as never).trim();

const GOAL: GoalSpec = { summary: "tests green", criteria: [
  { id: "c1", text: "npm test passes", verify: "npm test" },
  { id: "c2", text: "lint clean" },
] };
const VERDICT: GoalVerdict = { met: false, criteria: [
  { id: "c1", met: false, evidence: "exit 1: npm test" },
  { id: "c2", met: false, evidence: "no deterministic verify; needs judge" },
], unmet: ["c1", "c2"], confidence: 0.5, reason: "unmet: c1, c2" };

const RUBRIC_FULL_GOLDEN = "You are a STRICT ACCEPTANCE REVIEWER. You did NOT write the work under review and have no stake in it passing. Decide, criterion by criterion, whether the GOAL is objectively met using ONLY the ARTIFACTS provided (command results, git diff, file contents). You are auditing, not assisting.\n\nRules:\n1. DEFAULT DENY. Every criterion is met:false until artifact evidence PROVES it. Absence of evidence = not met. Ambiguity = not met. In doubt = not met.\n2. ARTIFACTS ONLY. Valid evidence = a machine signal (command + exitCode + output), a specific diff hunk, or specific file content.\n3. THE REPORT IS A CLAIM, NOT EVIDENCE. The worker's claim is its own assertion. Prose like \"all tests pass\", \"done\", \"fixed\" proves nothing without the matching machine output. If the claim contradicts the artifacts, the artifacts win — note the mismatch.\n4. MACHINE SIGNALS. exitCode 0 counts as evidence FOR a criterion ONLY if the command actually verifies that criterion AND its output is consistent with success. exit 0 of an unrelated/empty/no-op command proves nothing. exitCode non-zero = verification FAILED → that criterion is met:false; cite the failing output. A criterion that needs a verification command but has no corresponding signal = met:false (unverified).\n5. CITE OR IT DIDN'T HAPPEN. Each criterion's evidence MUST reference a concrete artifact: a command + exitCode, a diff hunk path/line, or a file path + short excerpt. \"The report says…\" is NOT a citation and forces met:false.\n6. IGNORE tone, confidence, formatting, length, and reasoning-flavored phrases. Longer output is not better. Order of evidence does not imply importance.\n7. TRUNCATION. If an output is truncated and the missing part is needed to confirm a criterion, do NOT assume it passed — met:false, lower confidence.\n\nDecide each criterion, then met overall = (every criterion met). Be skeptical about MET; be confident about UNMET when a command clearly fails.\n\nOUTPUT: respond with ONLY one JSON object — no markdown fences, no text before or after — matching exactly:\n{\"met\": boolean, \"criteria\": [{\"id\": string, \"met\": boolean, \"evidence\": string}], \"unmet\": string[], \"confidence\": number, \"reason\": string}\n- met: true ONLY if every criterion is met.\n- criteria[].evidence: cite the artifact; for met:false name what is missing or failing.\n- unmet: ids of every met:false criterion.\n- confidence: 0..1, your certainty the verdict is correct GIVEN the evidence (lower when artifacts are missing/ambiguous/truncated). NOT a measure of work quality.\n- reason: 1-3 sentences naming the decisive artifacts.\nPut ALL reasoning INSIDE these fields. Emit no text outside the JSON object.\n\n----\n\nGOAL: tests green\n\nCRITERIA (grade each):\n- [c1] npm test passes   (verify: npm test)\n- [c2] lint clean   (verify: —)\n\nEVIDENCE — MACHINE SIGNALS:\n[c1] $ npm test  ->  exit 1\nFAIL: 1 test\n\nEVIDENCE — GIT DIFF:\ndiff --git a/x b/x\n\nEVIDENCE — FILES:\n=== src/x.ts ===\nexport const x = 1;\n\nWORKER CLAIM (UNVERIFIED — NOT evidence):\nall done, tests pass";

const RUBRIC_MIN_TAIL = "\n\n----\n\nGOAL: tests green\n\nCRITERIA (grade each):\n- [c1] npm test passes   (verify: npm test)\n- [c2] lint clean   (verify: —)\n\nEVIDENCE — MACHINE SIGNALS:\n(none)\n\nEVIDENCE — GIT DIFF:\n(none)\n\nWORKER CLAIM (UNVERIFIED — NOT evidence):\n(none)";
const RULES_BLOCK = RUBRIC_FULL_GOLDEN.split("\n\n----\n\n")[0];
const RUBRIC_MIN_GOLDEN = RULES_BLOCK + RUBRIC_MIN_TAIL;

const REPARSE = "\n\nYour previous reply was not valid JSON matching the schema. Return ONLY the JSON object, no markdown fences, nothing before or after.";

const BUNDLE_FULL: EvidenceBundle = {
  machineSignals: [{ criterionId: "c1", command: "npm test", exitCode: 1, output: "FAIL: 1 test" }],
  diff: "diff --git a/x b/x",
  files: [{ path: "src/x.ts", content: "export const x = 1;" }],
  reportClaim: "all done, tests pass",
};
const BUNDLE_MIN: EvidenceBundle = { machineSignals: [] };

describe("loop prompt centralization — rendered templates equal the prior inline text", () => {
  it("continuation frames the message as an AUTOMATED goal-check (not a human) and instructs the worker to REPORT, never to just stop", () => {
    const out = render(CONTINUATION_TEMPLATE, buildContinuationVars(GOAL, VERDICT, 2));
    // unmistakably automated, not a human/orchestrator message
    assert.match(out, /AUTOMATED GOAL-CHECK/);
    assert.match(out, /NOT a message from a human/i);
    // carries the goal + unmet criteria (the existing vars)
    assert.match(out, /tests green/);
    assert.match(out, /npm test passes — exit 1: npm test/);
    assert.match(out, /attempt 2/i);
    // instructs reporting via send_message_to_parent with result:
    assert.match(out, /send_message_to_parent/);
    assert.match(out, /result:/);
    // the broken instruction is GONE
    assert.doesNotMatch(out, /just stop — you'll be re-checked/i);
    assert.match(out, /Do NOT just stop/i);
  });

  it("judge rubric (full evidence) == prior buildJudgePrompt output", () => {
    assert.equal(render(JUDGE_RUBRIC_TEMPLATE, buildJudgeVars(GOAL, BUNDLE_FULL)), RUBRIC_FULL_GOLDEN);
  });

  it("judge rubric (no evidence) == prior output and drops the FILES section", () => {
    const out = render(JUDGE_RUBRIC_TEMPLATE, buildJudgeVars(GOAL, BUNDLE_MIN));
    assert.equal(out, RUBRIC_MIN_GOLDEN);
    assert.ok(!out.includes("EVIDENCE — FILES:"));
  });

  it("RETRY flag appends the exact reparse reminder", () => {
    const out = render(JUDGE_RUBRIC_TEMPLATE, { ...buildJudgeVars(GOAL, BUNDLE_FULL), RETRY: "1" });
    assert.equal(out, RUBRIC_FULL_GOLDEN + REPARSE);
  });

  it("exhausted-release template renders the reason annotation + the held report", () => {
    const out = render(EXHAUSTED_RELEASE_TEMPLATE, buildExhaustedReleaseVars(GOAL, VERDICT, "reached the attempt limit (2 attempts)", "result: I claim done"));
    assert.equal(out, "This worker's loop ended WITHOUT meeting the goal: tests green\nReason: reached the attempt limit (2 attempts)\n\nStill unmet:\n- npm test passes — exit 1: npm test\n- lint clean — no deterministic verify; needs judge\n\nIts final report is below — treat it as UNVERIFIED, the goal was never confirmed met:\n\nresult: I claim done");
  });
});
