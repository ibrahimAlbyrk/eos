import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentEventSchema, WorkflowCompletedEventSchema, WorkflowStartedEventSchema } from "../canonical.ts";
import { WORKFLOW_AGENT_ID_RE, WorkflowRunDetailSchema, WorkflowRunProgressSchema } from "../workflow-run.ts";

const snapshot = {
  phases: [{ index: 1, title: "Review" }, { index: 2, title: "Verify", detail: "check each finding" }],
  agents: [
    { index: 1, label: "review:bugs", phaseIndex: 1, agentId: "a543b520564afb462", state: "done", tokens: 48000, toolCalls: 16, resultPreview: "3 findings" },
    { index: 2, label: "verify:bugs", phaseIndex: 2, state: "queued" },
  ],
  logs: ["Review: 3 findings"],
};

describe("workflow run events", () => {
  it("accepts a started event and routes it through the AgentEvent union", () => {
    const e = { type: "workflow_started", callId: "toolu_01", taskId: "wu9dw2i7x", runId: "wf_5dc20956-fb7", name: "review-changes", transcriptDir: "/x/subagents/workflows/wf_5dc20956-fb7" };
    assert.ok(WorkflowStartedEventSchema.safeParse(e).success);
    assert.ok(AgentEventSchema.safeParse(e).success);
  });

  it("requires callId and taskId on a started event", () => {
    assert.equal(WorkflowStartedEventSchema.safeParse({ type: "workflow_started", taskId: "t" }).success, false);
    assert.equal(WorkflowStartedEventSchema.safeParse({ type: "workflow_started", callId: "c" }).success, false);
  });

  it("accepts a completed event with its last snapshot", () => {
    const e = { type: "workflow_completed", callId: "toolu_01", taskId: "t", status: "completed", usage: { totalTokens: 1, toolUses: 2, durationMs: 3 }, snapshot };
    assert.ok(WorkflowCompletedEventSchema.safeParse(e).success);
    assert.ok(AgentEventSchema.safeParse(e).success);
  });

  it("rejects an unknown agent state", () => {
    const bad = { ...snapshot, agents: [{ index: 1, label: "x", state: "progress" }] };
    assert.equal(WorkflowCompletedEventSchema.safeParse({ type: "workflow_completed", callId: "c", taskId: "t", status: "completed", snapshot: bad }).success, false);
  });
});

describe("workflow run wire shapes", () => {
  it("accepts a progress payload and a run detail", () => {
    assert.ok(WorkflowRunProgressSchema.safeParse({ workerId: "w-1", callId: "c", taskId: "t", status: "running", snapshot, updatedAt: 1 }).success);
    assert.ok(WorkflowRunDetailSchema.safeParse({ callId: "c", taskId: "t", status: "running", snapshot, canStop: true }).success);
  });

  it("agent ids are Claude Code's short hex ids, never paths", () => {
    assert.ok(WORKFLOW_AGENT_ID_RE.test("a543b520564afb462"));
    for (const bad of ["../x", "a/b", "", "agent-a5"]) assert.equal(WORKFLOW_AGENT_ID_RE.test(bad), false, bad);
  });
});
