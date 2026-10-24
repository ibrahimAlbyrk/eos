// Background jobs — everything running on its own behind a chat or behind Eos:
// an agent's background shells, Monitors, subagents and Workflow runs, a `!`
// command, and Eos's own transfers, compaction, dreams and sync. One in-memory
// registry in the daemon (BackgroundJobService) feeds the header beacon and the
// Jobs side-panel tab. Never persisted: a daemon restart starts an empty list.
// Plan: docs/background-jobs/00-BACKGROUND-JOBS-PLAN.md.

import { z } from "zod";

export const BackgroundJobKindSchema = z.enum([
  "shell", "monitor", "agent", "workflow", "transfer", "compaction", "dream", "sync",
]);
export type BackgroundJobKind = z.infer<typeof BackgroundJobKindSchema>;

export const BackgroundJobStatusSchema = z.enum(["running", "completed", "failed", "stopped"]);
export type BackgroundJobStatus = z.infer<typeof BackgroundJobStatusSchema>;

export const BackgroundJobSchema = z.object({
  // Stable per job: `<kind>:<workerId|eos>:<source id>`.
  id: z.string(),
  kind: BackgroundJobKindSchema,
  status: BackgroundJobStatusSchema,
  // The chat the job belongs to; null = Eos itself (transfer, dream, sync).
  workerId: z.string().nullable(),
  title: z.string(),
  // The command a shell or Monitor runs — shown in mono.
  command: z.string().nullable(),
  // One line of what is happening now: last event, summary, bytes moved.
  detail: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  progress: z.object({ done: z.number().nonnegative(), total: z.number().nonnegative() }).nullable(),
  exitCode: z.number().int().nullable(),
  // The tool call that started it (agent / workflow / shell / monitor) — the
  // UI links to the call's transcript card or live view with it.
  callId: z.string().nullable(),
  // GET /api/jobs/:id/output has something to show.
  hasOutput: z.boolean(),
  canStop: z.boolean(),
});
export type BackgroundJob = z.infer<typeof BackgroundJobSchema>;

// GET /api/jobs — every job the daemon knows, running first.
export const BackgroundJobListSchema = z.object({ jobs: z.array(BackgroundJobSchema) });
export type BackgroundJobList = z.infer<typeof BackgroundJobListSchema>;

// GET /api/jobs/:id/output?since=<offset> — the output after `since` (the
// newest BACKGROUND_JOB_OUTPUT_MAX bytes of it when there is more). `next` is
// the offset to ask from next time; `reset` = the output started over (since
// was past its end), so the reader drops what it holds.
export const BackgroundJobOutputSchema = z.object({
  text: z.string(),
  next: z.number().int().nonnegative(),
  truncated: z.boolean(),
  reset: z.boolean(),
});
export type BackgroundJobOutput = z.infer<typeof BackgroundJobOutputSchema>;
export const BACKGROUND_JOB_OUTPUT_MAX = 64 * 1024;

// Bus topic "jobs:change": one job's new state, or ids dropped from the list.
export const BackgroundJobChangeSchema = z.object({
  job: BackgroundJobSchema.optional(),
  removed: z.array(z.string()).optional(),
});
export type BackgroundJobChange = z.infer<typeof BackgroundJobChangeSchema>;

export const BACKGROUND_JOB_TOPICS = { change: "jobs:change" } as const;
