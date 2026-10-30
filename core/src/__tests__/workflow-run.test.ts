import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_WORKFLOW_SNAPSHOT, applyWorkflowProgress, parseWorkflowRecord, settleWorkflowSnapshot, withWorkflowRecord,
  workflowAgentTranscriptPath, workflowRecordPath,
} from "../domain/workflow-run.ts";

// Entries as the bundled claude binary (0.3.284) sends them in
// system/task_progress.workflow_progress — copied from a real run's record,
// long previews trimmed.
const phase = (index: number, title: string) => ({ type: "workflow_phase", index, title });
const doneAgent = {
  type: "workflow_agent", index: 1, label: "contracts", phaseIndex: 1, phaseTitle: "Contracts",
  agentId: "a543b520564afb462", model: "claude-opus-5-5", state: "done",
  startedAt: 1791493056944, queuedAt: 1791493056904, attempt: 1,
  lastToolName: "StructuredOutput", lastToolSummary: "done", promptPreview: "You are one specialist…",
  promptFramed: true, lastProgressAt: 1791495084252, tokens: 361652, toolCalls: 68, durationMs: 2027306,
  resultPreview: "{\"status\":\"done\"…",
};
const queued = { type: "workflow_agent", index: 2, label: "agent-plane", phaseIndex: 2, phaseTitle: "Build", state: "start", queuedAt: 1791495084271, promptPreview: "Build the agent plane…" };

describe("applyWorkflowProgress", () => {
  it("reads phases and agents from a real run's entries", () => {
    const s = applyWorkflowProgress(EMPTY_WORKFLOW_SNAPSHOT, [phase(1, "Contracts"), phase(2, "Build"), doneAgent, queued]);
    assert.deepEqual(s.phases, [{ index: 1, title: "Contracts" }, { index: 2, title: "Build" }]);
    assert.equal(s.agents.length, 2);
    const [a, b] = s.agents;
    assert.equal(a.state, "done");
    assert.equal(a.tokens, 361652);
    assert.equal(a.durationMs, 2027306);
    assert.equal(a.agentId, "a543b520564afb462");
    assert.equal("promptFramed" in a, false, "unknown fields are dropped");
    assert.equal(b.state, "queued", "start without startedAt is queued");
  });

  it("start with startedAt and progress read as running; unknown states too", () => {
    const s = applyWorkflowProgress(EMPTY_WORKFLOW_SNAPSHOT, [
      { ...queued, startedAt: 1 },
      { type: "workflow_agent", index: 3, label: "x", state: "progress" },
      { type: "workflow_agent", index: 4, label: "y", state: "warming-up" },
      { type: "workflow_agent", index: 5, label: "z", state: "error", error: "blocked", blocked: true },
    ]);
    assert.deepEqual(s.agents.map((a) => a.state), ["running", "running", "running", "error"]);
    assert.equal(s.agents[3].error, "blocked");
  });

  it("merges by index: a later entry updates its agent and keeps what it omits", () => {
    const first = applyWorkflowProgress(EMPTY_WORKFLOW_SNAPSHOT, [{ ...queued, startedAt: 5, state: "start" }]);
    const next = applyWorkflowProgress(first, [{ type: "workflow_agent", index: 2, label: "agent-plane", state: "progress", lastToolName: "Read", lastToolSummary: "src/a.ts" }]);
    const a = next.agents[0];
    assert.equal(a.state, "running");
    assert.equal(a.lastToolName, "Read");
    assert.equal(a.startedAt, 5);
    assert.equal(a.promptPreview, "Build the agent plane…");
  });

  it("logs replace the earlier list only when the new one has any", () => {
    const withLogs = applyWorkflowProgress(EMPTY_WORKFLOW_SNAPSHOT, [{ type: "workflow_log", message: "Review: 3 findings" }]);
    assert.deepEqual(withLogs.logs, ["Review: 3 findings"]);
    assert.deepEqual(applyWorkflowProgress(withLogs, [phase(1, "Review")]).logs, ["Review: 3 findings"]);
  });

  it("ignores anything that isn't a list of entries", () => {
    const s = applyWorkflowProgress(EMPTY_WORKFLOW_SNAPSHOT, [phase(1, "A")]);
    for (const bad of [undefined, null, "x", { type: "workflow_phase" }, 3]) assert.equal(applyWorkflowProgress(s, bad), s);
    const junk = applyWorkflowProgress(s, [null, 1, { type: "workflow_agent" }, { type: "workflow_phase", index: 0, title: "zero" }]);
    assert.deepEqual(junk, { ...s, logs: [] });
  });
});

describe("workflow records", () => {
  const record = JSON.stringify({
    runId: "wf_5dc20956-fb7", status: "completed",
    phases: [{ title: "Contracts", detail: "the shared interface" }, { title: "Build", detail: "7 specialists" }],
    logs: ["Contracts: done — 25 files"],
    workflowProgress: [phase(1, "Contracts"), phase(2, "Build"), doneAgent],
  });

  it("adds phase details and logs to a live snapshot", () => {
    const live = applyWorkflowProgress(EMPTY_WORKFLOW_SNAPSHOT, [phase(1, "Contracts"), phase(2, "Build"), doneAgent, queued]);
    const s = withWorkflowRecord(live, parseWorkflowRecord(record)!);
    assert.deepEqual(s.phases.map((p) => p.detail), ["the shared interface", "7 specialists"]);
    assert.deepEqual(s.logs, ["Contracts: done — 25 files"]);
    assert.equal(s.agents.length, 2, "the live agents win over the record's");
  });

  it("rebuilds an unknown run from the record alone", () => {
    const s = withWorkflowRecord(EMPTY_WORKFLOW_SNAPSHOT, parseWorkflowRecord(record)!);
    assert.equal(s.agents.length, 1);
    assert.equal(s.phases[1].title, "Build");
  });

  it("refuses records that aren't JSON objects", () => {
    assert.equal(parseWorkflowRecord("nope"), null);
    assert.equal(parseWorkflowRecord("[1]"), null);
  });

  it("derives the record and agent paths only from a real transcriptDir", () => {
    const dir = "/Users/u/.claude/projects/-p/3cad/subagents/workflows/wf_5dc20956-fb7";
    assert.equal(workflowRecordPath(dir), "/Users/u/.claude/projects/-p/3cad/workflows/wf_5dc20956-fb7.json");
    assert.equal(workflowAgentTranscriptPath(dir, "a543b520564afb462"), `${dir}/agent-a543b520564afb462.jsonl`);
    const win = "C:\\Users\\u\\.claude\\projects\\C--p\\3cad\\subagents\\workflows\\wf_1";
    assert.equal(workflowRecordPath(win), "C:\\Users\\u\\.claude\\projects\\C--p\\3cad\\workflows\\wf_1.json");
    assert.equal(workflowAgentTranscriptPath(win, "a1"), `${win}\\agent-a1.jsonl`);
    for (const bad of ["relative/subagents/workflows/wf_1", "/x/subagents/workflows/../wf_1", "/x/../y/subagents/workflows/wf_1", "/x/workflows/wf_1", "/x/subagents/workflows/wf_1/", "C:\\x\\..\\y\\subagents\\workflows\\wf_1", "x\\subagents\\workflows\\wf_1"]) {
      assert.equal(workflowRecordPath(bad), null, bad);
    }
  });
});

describe("settleWorkflowSnapshot", () => {
  // Claude Code's own record of a stopped run (status "killed") still has its
  // in-flight agents in "progress".
  const live = applyWorkflowProgress(EMPTY_WORKFLOW_SNAPSHOT, [
    doneAgent,
    { type: "workflow_agent", index: 2, label: "read:core", state: "progress", startedAt: 1 },
    { ...queued, index: 3 },
  ]);

  it("a stopped or failed run cancels what was still in flight", () => {
    for (const status of ["stopped", "failed"] as const) {
      assert.deepEqual(settleWorkflowSnapshot(live, status).agents.map((a) => a.state), ["done", "cancelled", "cancelled"]);
    }
  });

  it("a completed run finished every agent it awaited", () => {
    assert.deepEqual(settleWorkflowSnapshot(live, "completed").agents.map((a) => a.state), ["done", "done", "done"]);
  });

  it("leaves a settled snapshot as it is", () => {
    const settled = settleWorkflowSnapshot(live, "stopped");
    assert.equal(settleWorkflowSnapshot(settled, "stopped"), settled);
  });
});
