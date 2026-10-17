// Live view of a Claude Code Workflow run (the inline run card and the
// workflow:<workerId>/<callId> side-panel tab). The durable record is the two
// workflow_* agent events (canonical.ts); progress between them is ephemeral.
// Plan: docs/workflow-runs/00-WORKFLOW-RUNS-PLAN.md.

import { z } from "zod";
import { SubagentUsageSchema, WorkflowRunSnapshotSchema } from "./canonical.ts";
import { PtyConversationRowSchema } from "./http.ts";

export const WorkflowRunStatusSchema = z.enum(["running", "completed", "failed", "stopped"]);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;

// Bus topic "workflow:progress" (claude SDK lane): the latest snapshot of a
// running Workflow, and once more with its final status when it ends. Never
// persisted.
export const WorkflowRunProgressSchema = z.object({
  workerId: z.string(),
  callId: z.string(),
  taskId: z.string(),
  status: WorkflowRunStatusSchema,
  snapshot: WorkflowRunSnapshotSchema,
  usage: SubagentUsageSchema.optional(),
  updatedAt: z.number(),
});
export type WorkflowRunProgress = z.infer<typeof WorkflowRunProgressSchema>;

export const WORKFLOW_RUN_TOPICS = { progress: "workflow:progress" } as const;

// GET /workers/:id/workflow-runs/:callId — one run, live or finished.
// GET /workers/:id/workflow-runs — { runs } of the runs still running.
export const WorkflowRunDetailSchema = z.object({
  callId: z.string(),
  taskId: z.string(),
  runId: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  status: WorkflowRunStatusSchema,
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  summary: z.string().optional(),
  usage: SubagentUsageSchema.optional(),
  snapshot: WorkflowRunSnapshotSchema,
  // The session can stop this run (a live run on a lane with per-task stop).
  canStop: z.boolean(),
});
export type WorkflowRunDetail = z.infer<typeof WorkflowRunDetailSchema>;

export const WorkflowRunListSchema = z.object({ runs: z.array(WorkflowRunDetailSchema) });
export type WorkflowRunList = z.infer<typeof WorkflowRunListSchema>;

// GET /workers/:id/workflow-runs/:callId/agents/:agentId — the agent's own
// transcript as worker-event rows (the newest WORKFLOW_AGENT_ROWS_MAX).
export const WorkflowAgentRowsSchema = z.object({ rows: z.array(PtyConversationRowSchema) });
export type WorkflowAgentRows = z.infer<typeof WorkflowAgentRowsSchema>;
export const WORKFLOW_AGENT_ROWS_MAX = 200;

// A workflow agent's id as Claude Code names it (agent-<id>.jsonl).
export const WORKFLOW_AGENT_ID_RE = /^[a-z0-9]{6,40}$/;
