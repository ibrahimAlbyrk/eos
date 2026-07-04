import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SubagentStartedEventSchema,
  SubagentCompletedEventSchema,
  AgentEventSchema,
} from "../canonical.ts";

describe("SubagentStartedEventSchema", () => {
  it("accepts a full started event", () => {
    const r = SubagentStartedEventSchema.safeParse({
      type: "subagent_started",
      callId: "toolu_01",
      agentId: "agent-1",
      background: true,
      agentType: "Explore",
      description: "scan repo",
      outputFile: "/tmp/agent-1.out",
    });
    assert.ok(r.success);
  });

  it("accepts the minimal required shape (callId, agentId, background)", () => {
    const r = SubagentStartedEventSchema.safeParse({
      type: "subagent_started", callId: "toolu_01", agentId: "agent-1", background: true,
    });
    assert.ok(r.success);
  });

  it("rejects when a required field is missing", () => {
    assert.equal(SubagentStartedEventSchema.safeParse({
      type: "subagent_started", agentId: "agent-1", background: true,
    }).success, false);
    assert.equal(SubagentStartedEventSchema.safeParse({
      type: "subagent_started", callId: "toolu_01", background: true,
    }).success, false);
    assert.equal(SubagentStartedEventSchema.safeParse({
      type: "subagent_started", callId: "toolu_01", agentId: "agent-1",
    }).success, false);
  });
});

describe("SubagentCompletedEventSchema", () => {
  it("accepts the minimal required shape (agentId, status)", () => {
    const r = SubagentCompletedEventSchema.safeParse({
      type: "subagent_completed", agentId: "agent-1", status: "completed",
    });
    assert.ok(r.success);
  });

  it("accepts the full shape incl. null callId (correlation fallback) and usage", () => {
    const r = SubagentCompletedEventSchema.safeParse({
      type: "subagent_completed",
      agentId: "agent-1",
      callId: null,
      status: "failed",
      result: "final output text",
      outputFile: "/tmp/agent-1.out",
      usage: { totalTokens: 1200, toolUses: 4, durationMs: 5400 },
    });
    assert.ok(r.success);
  });

  it("rejects an unknown status and a missing agentId", () => {
    assert.equal(SubagentCompletedEventSchema.safeParse({
      type: "subagent_completed", agentId: "agent-1", status: "exploded",
    }).success, false);
    assert.equal(SubagentCompletedEventSchema.safeParse({
      type: "subagent_completed", status: "completed",
    }).success, false);
  });

  it("rejects negative usage counters", () => {
    assert.equal(SubagentCompletedEventSchema.safeParse({
      type: "subagent_completed", agentId: "agent-1", status: "completed",
      usage: { totalTokens: -1 },
    }).success, false);
  });
});

describe("AgentEventSchema union", () => {
  it("routes both subagent kinds through the discriminated union", () => {
    assert.ok(AgentEventSchema.safeParse({
      type: "subagent_started", callId: "toolu_01", agentId: "agent-1", background: true,
    }).success);
    assert.ok(AgentEventSchema.safeParse({
      type: "subagent_completed", agentId: "agent-1", callId: "toolu_01", status: "stopped",
    }).success);
  });
});
