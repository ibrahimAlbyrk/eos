// Dreaming runs — while the user is away Eos rereads finished chats (recall, one
// model call per chat), consolidates what it noticed against what it already knows
// (one call), and files memory proposals for the morning review. Settings live on
// the profile (profile.ts DreamingSettings); runs, watermarks and chat exclusions are
// a regenerable log in state.db. The two model outputs are parsed with the schemas
// here — anything that doesn't fit is dropped, never half-applied.

import { z } from "zod";
import { DreamProposalKindSchema, UserMemoryCategorySchema, USER_MEMORY_TEXT_MAX } from "./profile.ts";

// ---- model outputs ------------------------------------------------------------

// One thing a chat shows about the user. `evidence` = event ids from the rendered
// transcript's [e<id>] tags.
export const DreamObservationSchema = z.object({
  statement: z.string().trim().min(1).max(USER_MEMORY_TEXT_MAX),
  kind: z.enum(["correction", "preference", "habit", "project-fact", "drift"]),
  scope: z.enum(["global", "project"]),
  evidence: z.array(z.number().int()).max(8),
});
export type DreamObservation = z.infer<typeof DreamObservationSchema>;

export const DreamRecallOutputSchema = z.object({
  observations: z.array(DreamObservationSchema).max(20),
});
export type DreamRecallOutput = z.infer<typeof DreamRecallOutputSchema>;

export const DreamDroppedSchema = z.object({
  oneOff: z.number().int().nonnegative().default(0),
  known: z.number().int().nonnegative().default(0),
  declined: z.number().int().nonnegative().default(0),
  secret: z.number().int().nonnegative().default(0),
  weak: z.number().int().nonnegative().default(0),
  invalid: z.number().int().nonnegative().default(0),
});
export type DreamDropped = z.infer<typeof DreamDroppedSchema>;

export const DreamProposalDraftSchema = z.object({
  kind: DreamProposalKindSchema,
  text: z.string().trim().min(1).max(USER_MEMORY_TEXT_MAX),
  category: UserMemoryCategorySchema,
  scope: z.enum(["global", "project"]),
  // The project folder a project-scoped proposal belongs to (one of the chats').
  project: z.string().nullable().default(null),
  // Memory ids it changes (update/promote/retire: one; merge: two or more).
  targets: z.array(z.string()).max(6).default([]),
  confidence: z.number().int().min(1).max(3),
  evidence: z.array(z.number().int()).max(8).default([]),
});
export type DreamProposalDraft = z.infer<typeof DreamProposalDraftSchema>;

export const DreamConsolidateOutputSchema = z.object({
  narrative: z.string().trim().max(700).default(""),
  proposals: z.array(DreamProposalDraftSchema).max(12),
  dropped: DreamDroppedSchema.partial().default({}),
});
export type DreamConsolidateOutput = z.infer<typeof DreamConsolidateOutputSchema>;

// ---- runs ---------------------------------------------------------------------

export const DreamTriggerSchema = z.enum(["nightly", "away", "manual"]);
export type DreamTrigger = z.infer<typeof DreamTriggerSchema>;

export const DreamRunStatusSchema = z.enum(["running", "done", "skipped", "failed", "stopped"]);
export type DreamRunStatus = z.infer<typeof DreamRunStatusSchema>;

export const DreamChatReadSchema = z.object({
  workerId: z.string(),
  name: z.string(),
  project: z.string().nullable(),
  userTurns: z.number().int().nonnegative(),
  observations: z.number().int().nonnegative(),
});
export type DreamChatRead = z.infer<typeof DreamChatReadSchema>;

export const DreamRunSchema = z.object({
  id: z.string(),
  trigger: DreamTriggerSchema,
  status: DreamRunStatusSchema,
  // Why it skipped / failed / stopped, in words the log shows.
  reason: z.string().nullable(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  model: z.string(),
  chatsRead: z.number().int().nonnegative(),
  observations: z.number().int().nonnegative(),
  proposed: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  narrative: z.string().nullable(),
  dropped: DreamDroppedSchema,
  chats: z.array(DreamChatReadSchema),
});
export type DreamRun = z.infer<typeof DreamRunSchema>;

export const DreamListResponseSchema = z.object({
  runs: z.array(DreamRunSchema),
  // Root chats the user turned off — no dream reads them.
  excluded: z.array(z.string()),
});
export type DreamListResponse = z.infer<typeof DreamListResponseSchema>;

export const DreamProgressSchema = z.object({
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  chat: z.string().nullable(),
  noticed: z.array(z.string()).max(6),
});
export type DreamProgress = z.infer<typeof DreamProgressSchema>;

// Why a dream can't run right now (null = it can).
export const DreamBlockSchema = z.enum(["disabled", "sign-in", "usage"]);
export type DreamBlock = z.infer<typeof DreamBlockSchema>;

export const DreamStatusSchema = z.object({
  running: z.boolean(),
  runId: z.string().nullable(),
  progress: DreamProgressSchema.nullable(),
  lastRun: DreamRunSchema.nullable(),
  nextAt: z.number().nullable(),
  blocked: DreamBlockSchema.nullable(),
});
export type DreamStatus = z.infer<typeof DreamStatusSchema>;

export const DreamExclusionRequestSchema = z.object({
  workerId: z.string().min(1),
  excluded: z.boolean(),
});
export type DreamExclusionRequest = z.infer<typeof DreamExclusionRequestSchema>;

// SSE `dream:change` payload — status changed or progress moved.
export const DreamChangeEventSchema = z.object({
  runId: z.string().nullable(),
  status: DreamRunStatusSchema,
});
export type DreamChangeEvent = z.infer<typeof DreamChangeEventSchema>;
