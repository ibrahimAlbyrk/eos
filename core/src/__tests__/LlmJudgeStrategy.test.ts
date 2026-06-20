import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LlmJudgeStrategy } from "../services/LlmJudgeStrategy.ts";
import type { GoalSpec } from "../../../contracts/src/loop.ts";
import type { GoalContext } from "../ports/GoalCheckStrategy.ts";
import type { EvidenceBundle } from "../ports/EvidenceCollector.ts";

const noopLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLog; } };
const CTX: GoalContext = { workerId: "w-1", attempt: 0 };

const GOAL_1: GoalSpec = { summary: "tests pass", criteria: [{ id: "c1", text: "npm test green", verify: "npm test" }] };
const GOAL_2: GoalSpec = { summary: "two things", criteria: [{ id: "c1", text: "a", verify: "npm test" }, { id: "c2", text: "b" }] };

const BUNDLE: EvidenceBundle = {
  machineSignals: [{ criterionId: "c1", command: "npm test", exitCode: 0, output: "all good" }],
  diff: "diff --git a/x b/x",
  reportClaim: "I did everything, all tests pass.",
};

// The renderer records the (template id, vars) the strategy shapes, and returns a
// deterministic stand-in prompt — the real rubric prose is verified in the
// manager equivalence test, not here.
function strategy(responses: string[], bundle: EvidenceBundle = BUNDLE) {
  const judgeCalls: string[] = [];
  const judgeOpts: Array<{ temperature?: number } | undefined> = [];
  const renders: Array<{ id: string; vars: Record<string, unknown> }> = [];
  let i = 0;
  const svc = new LlmJudgeStrategy({
    judge: { judge: async (prompt: string, opts?: { temperature?: number }): Promise<string> => { judgeCalls.push(prompt); judgeOpts.push(opts); return responses[Math.min(i++, responses.length - 1)]; } },
    evidence: { collect: async () => bundle },
    renderer: { render: (id: string, vars: Record<string, unknown> = {}) => { renders.push({ id, vars }); return `PROMPT[${renders.length}]`; } },
    temperature: 0.1,
    log: noopLog,
  });
  return { svc, judgeCalls, judgeOpts, renders };
}

describe("LlmJudgeStrategy", () => {
  it("parses a valid JSON verdict", async () => {
    const { svc, renders } = strategy(['{"met":true,"criteria":[{"id":"c1","met":true,"evidence":"exit 0: npm test"}],"unmet":[],"confidence":0.9,"reason":"tests pass"}']);
    const v = await svc.evaluate(GOAL_1, CTX);
    assert.equal(v.met, true);
    assert.equal(v.criteria[0].evidence, "exit 0: npm test");
    assert.equal(renders[0].id, "loop/judge-rubric");
  });

  it("passes the configured temperature to the judge call", async () => {
    const { svc, judgeOpts } = strategy(['{"met":false,"criteria":[{"id":"c1","met":false,"evidence":"x"}],"unmet":["c1"],"confidence":0.5,"reason":"r"}']);
    await svc.evaluate(GOAL_1, CTX);
    assert.equal(judgeOpts[0]?.temperature, 0.1);
  });

  it("shapes vars that DEMOTE the report to a claim and include the machine signal", async () => {
    const { svc, renders } = strategy(['{"met":false,"criteria":[{"id":"c1","met":false,"evidence":"x"}],"unmet":["c1"],"confidence":0.5,"reason":"r"}']);
    await svc.evaluate(GOAL_1, CTX);
    assert.equal(renders[0].vars.CLAIM, "I did everything, all tests pass.");   // the claim is a var, not evidence
    assert.match(String(renders[0].vars.MACHINE_SIGNALS), /npm test\s+->\s+exit 0/); // machine signal present
  });

  it("surfaces collector-read file content to the rubric as the FILES var (judge grades real content)", async () => {
    const bundle: EvidenceBundle = {
      machineSignals: [],
      files: [{ path: "/tmp/haiku.txt", content: "old pond\na frog leaps in\nwater's sound" }],
    };
    const { svc, renders } = strategy(['{"met":true,"criteria":[{"id":"c1","met":true,"evidence":"valid haiku in /tmp/haiku.txt"}],"unmet":[],"confidence":0.9,"reason":"ok"}'], bundle);
    const v = await svc.evaluate({ summary: "haiku", criteria: [{ id: "c1", text: "a valid haiku exists at /tmp/haiku.txt" }] }, CTX);
    assert.equal(v.met, true);
    assert.match(String(renders[0].vars.FILES), /\/tmp\/haiku\.txt/);
    assert.match(String(renders[0].vars.FILES), /frog leaps/);
  });

  it("malformed JSON → one reparse/retry (RETRY var set), then unmet (never crash, never met-by-default)", async () => {
    const { svc, judgeCalls, renders } = strategy(["not json at all", "still not json"]);
    const v = await svc.evaluate(GOAL_1, CTX);
    assert.equal(v.met, false);
    assert.equal(v.reason, "judge output unparseable");
    assert.equal(judgeCalls.length, 2);              // retried exactly once
    assert.equal(renders[0].vars.RETRY, undefined);  // first render: no retry flag
    assert.equal(renders[1].vars.RETRY, "1");        // second render: retry flag set
  });

  it("normalizes an inconsistent verdict toward unmet (met:true with a failing criterion → met:false)", async () => {
    const { svc } = strategy(['{"met":true,"criteria":[{"id":"c1","met":true,"evidence":"ok"},{"id":"c2","met":false,"evidence":"bad"}],"unmet":["c2"],"confidence":0.8,"reason":"r"}']);
    const v = await svc.evaluate(GOAL_2, CTX);
    assert.equal(v.met, false);
    assert.deepEqual(v.unmet, ["c2"]);
  });

  it("a throwing judge fails closed to unmet", async () => {
    const svc = new LlmJudgeStrategy({
      judge: { judge: async () => { throw new Error("backend down"); } },
      evidence: { collect: async () => BUNDLE },
      renderer: { render: () => "PROMPT" },
      temperature: 0.1,
      log: noopLog,
    });
    const v = await svc.evaluate(GOAL_1, CTX);
    assert.equal(v.met, false);
  });
});
