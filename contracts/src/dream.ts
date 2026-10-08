// Dreaming runs — while the user is away Eos rereads finished chats and keeps only
// what lasts. Recall (one model call per chat) notes signals: what the user asked
// for, about what, and how they said it — no conclusions. Code drops the ones about
// the product or one task. Match (one call) files the rest into a candidate ledger
// that outlives the night, so support is COUNTED across separate chats and days
// instead of guessed. Consolidate (one call, only for candidates that are ready)
// writes at most a few proposals; a separate critic (one call) tries to refute each
// before the morning review sees it. Settings live on the profile
// (profile.ts DreamingSettings); runs, watermarks, exclusions and the ledger are a
// regenerable log in state.db. Model outputs are parsed with the schemas here —
// anything that doesn't fit is dropped, never half-applied.

import { z } from "zod";
import {
  DreamEvidenceSchema, DreamProposalKindSchema, UserMemoryDomainSchema, USER_MEMORY_TEXT_MAX, USER_MEMORY_WHY_MAX,
} from "./profile.ts";

// ---- recall -------------------------------------------------------------------

// What the signal is about. Only agent-behaviour (how the agent should work with the
// user) and user-fact (who the user is) can become memories; an artifact (this
// product, file, game, screen) or a project convention belongs to the code and docs.
export const DreamSignalObjectSchema = z.enum(["agent-behaviour", "user-fact", "artifact", "project-convention"]);
export type DreamSignalObject = z.infer<typeof DreamSignalObjectSchema>;

// How the user said it. general-rule: framed beyond this task · process-correction:
// corrected HOW the agent worked · task-instruction: a step of this task ·
// product-feedback: corrected WHAT the product does or looks like · choice: picked
// or accepted an option the agent offered.
export const DreamSignalStanceSchema = z.enum([
  "general-rule", "process-correction", "task-instruction", "product-feedback", "choice",
]);
export type DreamSignalStance = z.infer<typeof DreamSignalStanceSchema>;

// One thing a chat shows, before any judgement. `evidence` = event ids from the
// rendered transcript's [e<id>] tags, the user's own lines.
export const DreamSignalSchema = z.object({
  // What the user wants, close to their own words — not yet a rule or a trait.
  ask: z.string().trim().min(1).max(USER_MEMORY_TEXT_MAX),
  object: DreamSignalObjectSchema,
  stance: DreamSignalStanceSchema,
  // The user's own generalising words, verbatim ("bundan sonra", "always"); null when none.
  marker: z.string().trim().max(80).nullable().default(null),
  // Why, only when the user said it.
  reason: z.string().trim().max(USER_MEMORY_WHY_MAX).nullable().default(null),
  // It guards a public or irreversible action (posting, pushing, deleting, deploying).
  irreversible: z.boolean().default(false),
  evidence: z.array(z.number().int()).min(1).max(8),
});
export type DreamSignal = z.infer<typeof DreamSignalSchema>;

export const DreamRecallOutputSchema = z.object({
  signals: z.array(DreamSignalSchema).max(12),
});
export type DreamRecallOutput = z.infer<typeof DreamRecallOutputSchema>;

// ---- candidate ledger -----------------------------------------------------------

// One occasion a candidate was seen: a chat on a day, with the user's lines.
export const DreamSupportSchema = z.object({
  workerId: z.string().min(1),
  chat: z.string(),
  project: z.string().nullable(),
  // Local calendar day of the user's line (YYYY-MM-DD).
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  at: z.number(),
  stance: DreamSignalStanceSchema,
  marker: z.string().nullable(),
  reason: z.string().nullable(),
  irreversible: z.boolean(),
  evidence: z.array(DreamEvidenceSchema).max(4),
});
export type DreamSupport = z.infer<typeof DreamSupportSchema>;

// Something that may become a memory once it has shown up enough. `target` = a kept
// memory it would change: the signals say it no longer holds (update / retire), or
// it showed up beyond its project (promote).
export const DreamCandidateSchema = z.object({
  id: z.string().min(1),
  claim: z.string().trim().min(1).max(USER_MEMORY_TEXT_MAX),
  object: z.enum(["agent-behaviour", "user-fact"]),
  target: z.string().nullable(),
  support: z.array(DreamSupportSchema).min(1).max(24),
  firstSeen: z.number(),
  lastSeen: z.number(),
});
export type DreamCandidate = z.infer<typeof DreamCandidateSchema>;

// Match: tonight's signals filed against open candidates and existing memories.
// `signals` are s<N> indices from the prompt.
export const DreamMatchGroupSchema = z.object({
  signals: z.array(z.number().int().nonnegative()).min(1),
  // An open candidate these support.
  candidate: z.string().nullable().default(null),
  // A memory (kept, pending or declined) that already says it.
  memory: z.string().nullable().default(null),
  // With `memory`: the signals say that kept memory no longer holds.
  contradicts: z.boolean().default(false),
  // A new candidate's claim — one lasting preference, general, no task detail.
  claim: z.string().trim().max(USER_MEMORY_TEXT_MAX).nullable().default(null),
});
export type DreamMatchGroup = z.infer<typeof DreamMatchGroupSchema>;

export const DreamMatchOutputSchema = z.object({
  groups: z.array(DreamMatchGroupSchema).max(100),
});
export type DreamMatchOutput = z.infer<typeof DreamMatchOutputSchema>;

// ---- consolidate + critic -------------------------------------------------------

export const DreamDroppedSchema = z.object({
  oneOff: z.number().int().nonnegative().default(0),
  known: z.number().int().nonnegative().default(0),
  declined: z.number().int().nonnegative().default(0),
  secret: z.number().int().nonnegative().default(0),
  weak: z.number().int().nonnegative().default(0),
  invalid: z.number().int().nonnegative().default(0),
  // Code's filter on recall signals.
  product: z.number().int().nonnegative().default(0),
  taskBound: z.number().int().nonnegative().default(0),
  choice: z.number().int().nonnegative().default(0),
  // Refuted by the critic · failed the writing rules · the morning review is full.
  critic: z.number().int().nonnegative().default(0),
  style: z.number().int().nonnegative().default(0),
  capped: z.number().int().nonnegative().default(0),
});
export type DreamDropped = z.infer<typeof DreamDroppedSchema>;

export const DREAM_PROPOSALS_MAX = 3;

export const DreamProposalDraftSchema = z.object({
  // The ready candidate it comes from.
  candidate: z.string().min(1),
  kind: DreamProposalKindSchema,
  text: z.string().trim().min(1).max(USER_MEMORY_TEXT_MAX),
  category: z.enum(["about", "work-style", "stack"]),
  domain: UserMemoryDomainSchema,
  // Memory ids it changes (update/promote/retire: one; merge: two or more).
  targets: z.array(z.string()).max(6).default([]),
  // What goes wrong for an agent that doesn't know it.
  why: z.string().trim().min(1).max(USER_MEMORY_WHY_MAX),
});
export type DreamProposalDraft = z.infer<typeof DreamProposalDraftSchema>;

export const DreamSetAsideSchema = z.object({
  candidate: z.string().min(1),
  why: z.enum(["known", "declined", "oneOff", "product", "weak"]),
});

export const DreamConsolidateOutputSchema = z.object({
  narrative: z.string().trim().max(700).default(""),
  proposals: z.array(DreamProposalDraftSchema).max(DREAM_PROPOSALS_MAX),
  // Ready candidates it chose not to propose, and why.
  setAside: z.array(DreamSetAsideSchema).max(100).default([]),
});
export type DreamConsolidateOutput = z.infer<typeof DreamConsolidateOutputSchema>;

// The critic's answer for one proposal (p<N> from the prompt). `fails` = the numbers
// of the tests it fails (1 product · 2 one task · 3 known · 4 not a well-written rule
// · 5 like a declined one); `quotes` = whether each cited line actually says it.
export const DreamVerdictSchema = z.object({
  proposal: z.number().int().nonnegative(),
  keep: z.boolean(),
  fails: z.array(z.number().int().min(1).max(5)).max(5).default([]),
  quotes: z.array(z.object({ eventId: z.number().int(), says: z.enum(["yes", "topical", "no"]) })).max(8).default([]),
  reason: z.string().trim().max(USER_MEMORY_WHY_MAX).default(""),
});
export type DreamVerdict = z.infer<typeof DreamVerdictSchema>;

export const DreamCriticOutputSchema = z.object({
  verdicts: z.array(DreamVerdictSchema).max(DREAM_PROPOSALS_MAX),
});
export type DreamCriticOutput = z.infer<typeof DreamCriticOutputSchema>;

// ---- runs ---------------------------------------------------------------------

export const DreamTriggerSchema = z.enum(["nightly", "away", "manual"]);
export type DreamTrigger = z.infer<typeof DreamTriggerSchema>;

export const DreamRunStatusSchema = z.enum(["running", "done", "skipped", "failed", "stopped"]);
export type DreamRunStatus = z.infer<typeof DreamRunStatusSchema>;

export const DreamRejectedSchema = z.object({
  text: z.string().max(USER_MEMORY_TEXT_MAX),
  reason: z.string().max(USER_MEMORY_WHY_MAX),
});
export type DreamRejected = z.infer<typeof DreamRejectedSchema>;

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
  // Recall signals noted (before code's filter).
  observations: z.number().int().nonnegative(),
  proposed: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  narrative: z.string().nullable(),
  dropped: DreamDroppedSchema,
  chats: z.array(DreamChatReadSchema),
  // Candidates still gathering support after this run.
  candidates: z.number().int().nonnegative().default(0),
  // Proposals the critic or the writing rules turned down, with the reason.
  rejected: z.array(DreamRejectedSchema).max(12).default([]),
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
