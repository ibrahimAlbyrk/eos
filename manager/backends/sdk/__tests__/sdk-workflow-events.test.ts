// Workflow runs: the Workflow call's launch stub -> workflow_started,
// system/task_progress.workflow_progress -> onWorkflowProgress (never an event),
// task_notification / the <task-notification> user-turn carrier ->
// workflow_completed. The stub text and entry shapes are copied from a real run
// (claude-agent-sdk 0.3.284).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "../../../../contracts/src/canonical.ts";
import { createSdkEventMapper, type SdkEventMapper, type WorkflowProgress } from "../SdkEventMapper.ts";

const CALL_ID = "toolu_wf1";
const TASK_ID = "wu9dw2i7x";
const RUN_ID = "wf_5dc20956-fb7";
const DIR = `/Users/u/.claude/projects/-p/3cad/subagents/workflows/${RUN_ID}`;

const CALL = {
  type: "assistant",
  uuid: "u1",
  message: { id: "msg_A", content: [{ type: "tool_use", id: CALL_ID, name: "Workflow", input: { script: "export const meta = { name: 'review-changes' }" } }] },
};

const STUB_TEXT = `Workflow launched in background. Task ID: ${TASK_ID}\nSummary: Review changed files, verify each finding\nTranscript dir: ${DIR}\nScript file: /Users/u/.claude/projects/-p/3cad/workflows/scripts/review-changes-${RUN_ID}.js\nRun ID: ${RUN_ID}\n\nYou will be notified when it completes. Use /workflows to watch live progress.`;

const stub = (sidecar?: unknown) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: CALL_ID, content: [{ type: "text", text: STUB_TEXT }] }] },
  ...(sidecar ? { tool_use_result: sidecar } : {}),
});

const SIDECAR = { status: "async_launched", taskId: TASK_ID, taskType: "local_workflow", workflowName: "review-changes", runId: RUN_ID, summary: "Review changed files, verify each finding", transcriptDir: DIR, scriptPath: "/x.js" };

const TASK_STARTED = { type: "system", subtype: "task_started", task_id: TASK_ID, tool_use_id: CALL_ID, description: "Review changed files", task_type: "local_workflow", workflow_name: "review-changes" };

const progress = (entries: unknown[]) => ({
  type: "system", subtype: "task_progress", task_id: TASK_ID, tool_use_id: CALL_ID, description: "Review: bugs",
  usage: { total_tokens: 4000, tool_uses: 12, duration_ms: 30000 }, last_tool_name: "bugs", workflow_progress: entries,
});

const ENTRIES = [
  { type: "workflow_phase", index: 1, title: "Review" },
  { type: "workflow_agent", index: 1, label: "bugs", phaseIndex: 1, phaseTitle: "Review", agentId: "a8e1f3e896e86fcec", state: "progress", startedAt: 10, lastToolName: "Read", lastToolSummary: "src/a.ts", tokens: 4000, toolCalls: 12 },
];

const NOTIFICATION = { type: "system", subtype: "task_notification", task_id: TASK_ID, tool_use_id: CALL_ID, status: "completed", output_file: "/tmp/x.output", summary: "Workflow review-changes completed", usage: { total_tokens: 9000, tool_uses: 30, duration_ms: 60000 } };

const CARRIER = { type: "user", message: { content: `<task-notification>\n<task-id>${TASK_ID}</task-id>\n<tool-use-id>${CALL_ID}</tool-use-id>\n<status>completed</status>\n<summary>Workflow review-changes completed</summary>\n<result>{"confirmed":3}</result>\n</task-notification>` } };

function run(mapper: SdkEventMapper, msgs: unknown[]): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const m of msgs) out.push(...mapper.map(m as never));
  return out;
}

const workflowEvents = (events: AgentEvent[]) => events.filter((e) => e.type === "workflow_started" || e.type === "workflow_completed");

describe("SdkEventMapper — Workflow runs", () => {
  it("announces the run from the launch sidecar, keeping the tool_result block", () => {
    const out = run(createSdkEventMapper(), [CALL, TASK_STARTED, stub(SIDECAR)]);
    assert.ok(out.some((e) => e.type === "message" && e.role === "tool"));
    assert.deepEqual(workflowEvents(out), [{
      type: "workflow_started", callId: CALL_ID, taskId: TASK_ID, runId: RUN_ID, name: "review-changes",
      description: "Review changed files, verify each finding", transcriptDir: DIR,
    }]);
  });

  it("falls back to the launch text, taking the name from task_started", () => {
    const [e] = workflowEvents(run(createSdkEventMapper(), [CALL, TASK_STARTED, stub()]));
    assert.deepEqual(e, {
      type: "workflow_started", callId: CALL_ID, taskId: TASK_ID, runId: RUN_ID, name: "review-changes",
      description: "Review changed files, verify each finding", transcriptDir: DIR,
    });
  });

  it("relays progress as snapshots, never as events", () => {
    const seen: WorkflowProgress[] = [];
    const mapper = createSdkEventMapper({ onWorkflowProgress: (p) => seen.push(p) });
    const out = run(mapper, [CALL, TASK_STARTED, stub(SIDECAR), progress(ENTRIES)]);
    assert.deepEqual(out.filter((e) => e.type !== "message" && e.type !== "turn").map((e) => e.type), ["workflow_started"]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].callId, CALL_ID);
    assert.equal(seen[0].taskId, TASK_ID);
    assert.deepEqual(seen[0].usage, { totalTokens: 4000, toolUses: 12, durationMs: 30000 });
    assert.equal(seen[0].snapshot.agents[0].lastToolName, "Read");
    assert.equal(seen[0].snapshot.agents[0].state, "running");
  });

  it("progress that beats the launch stub still lands on the run", () => {
    const seen: WorkflowProgress[] = [];
    run(createSdkEventMapper({ onWorkflowProgress: (p) => seen.push(p) }), [CALL, TASK_STARTED, progress(ENTRIES)]);
    assert.equal(seen.length, 1);
  });

  it("counts the run as live until task_notification ends it with the last snapshot", () => {
    const mapper = createSdkEventMapper();
    run(mapper, [CALL, TASK_STARTED, stub(SIDECAR), progress(ENTRIES)]);
    assert.equal(mapper.liveSubagents, 1);
    const [done] = workflowEvents(run(mapper, [NOTIFICATION]));
    assert.equal(mapper.liveSubagents, 0);
    assert.equal(done.type, "workflow_completed");
    if (done.type !== "workflow_completed") return;
    assert.equal(done.status, "completed");
    assert.equal(done.summary, "Workflow review-changes completed");
    assert.deepEqual(done.usage, { totalTokens: 9000, toolUses: 30, durationMs: 60000 });
    assert.equal(done.snapshot?.agents[0].label, "bugs");
    assert.deepEqual(workflowEvents(run(mapper, [CARRIER])), [], "the carrier adds nothing");
  });

  it("the user-turn carrier ends a run whose notification never arrived", () => {
    const out = workflowEvents(run(createSdkEventMapper(), [CALL, TASK_STARTED, stub(SIDECAR), CARRIER]));
    assert.deepEqual(out.map((e) => e.type), ["workflow_started", "workflow_completed"]);
  });

  it("a session going away reports the live run as stopped, once", () => {
    const mapper = createSdkEventMapper();
    run(mapper, [CALL, TASK_STARTED, stub(SIDECAR)]);
    const stopped = mapper.stopLiveSubagents();
    assert.deepEqual(stopped.map((e) => e.type === "workflow_completed" && e.status), ["stopped"]);
    assert.deepEqual(mapper.stopLiveSubagents(), []);
  });

  it("a stopped run's end cancels the agents its last snapshot had in flight", () => {
    const mapper = createSdkEventMapper();
    run(mapper, [CALL, TASK_STARTED, stub(SIDECAR), progress(ENTRIES)]);
    const [end] = workflowEvents(run(mapper, [{ ...NOTIFICATION, status: "stopped" }]));
    assert.equal(end.type === "workflow_completed" && end.snapshot?.agents[0].state, "cancelled");
  });

  it("leaves other tasks' progress alone", () => {
    const seen: WorkflowProgress[] = [];
    const mapper = createSdkEventMapper({ onWorkflowProgress: (p) => seen.push(p) });
    run(mapper, [{ type: "system", subtype: "task_progress", task_id: "bash1", tool_use_id: "toolu_bash", description: "x", usage: {} }]);
    assert.equal(seen.length, 0);
  });

  it("a failed Workflow call announces nothing", () => {
    const failed = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: CALL_ID, is_error: true, content: [{ type: "text", text: "Workflow script failed to compile" }] }] } };
    assert.deepEqual(workflowEvents(run(createSdkEventMapper(), [CALL, failed])), []);
  });
});
