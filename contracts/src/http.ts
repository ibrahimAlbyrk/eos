// Daemon HTTP API surface — request/response schemas for every endpoint.
// Every route module on the daemon side parses with these, every CLI/web
// client also parses with these. The TUI singularity bug (calling
// /orchestrator/* singular when daemon exposed /orchestrators plural) would
// not have shipped if these had existed first.

import { z } from "zod";
import { WorkerRowSchema, PendingPermissionRowSchema, PermissionModeSchema } from "./worker.ts";
import { DecisionSchema, ExternalDecisionSchema } from "./policy.ts";

// ---- POST /workers ---------------------------------------------------------

export const SpawnWorkerRequestSchema = z
  .object({
    prompt: z.string().min(1),
    cwd: z.string().optional(),
    worktreeFrom: z.string().optional(),
    branch: z.string().optional(),
    name: z.string().optional(),
    withGateway: z.boolean().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    maxCostUsd: z.number().nonnegative().optional(),
    maxElapsedMs: z.number().int().positive().optional(),
    parentId: z.string().optional(),
  })
  .refine((b) => !!(b.cwd || b.worktreeFrom), {
    message: "cwd or worktreeFrom required",
  });
export type SpawnWorkerRequest = z.infer<typeof SpawnWorkerRequestSchema>;

export const SpawnWorkerResponseSchema = z.object({
  id: z.string(),
  port: z.number().int(),
});
export type SpawnWorkerResponse = z.infer<typeof SpawnWorkerResponseSchema>;

// ---- POST /orchestrators ---------------------------------------------------

export const SpawnOrchestratorRequestSchema = z.object({
  name: z.string().optional(),
  cwd: z.string().min(1),
  model: z.string().optional(),
  effort: z.string().optional(),
  prompt: z.string().optional(),
});
export type SpawnOrchestratorRequest = z.infer<typeof SpawnOrchestratorRequestSchema>;

export const SpawnOrchestratorResponseSchema = SpawnWorkerResponseSchema.extend({
  name: z.string().optional(),
});
export type SpawnOrchestratorResponse = z.infer<typeof SpawnOrchestratorResponseSchema>;

// ---- GET /workers, /orchestrators ------------------------------------------

export const WorkerListResponseSchema = z.array(WorkerRowSchema);
export const OrchestratorListResponseSchema = z.array(WorkerRowSchema);

// ---- POST /workers/:id/message and /orchestrators/:id/message --------------

export const MessageRequestSchema = z.object({ text: z.string().min(1) });
export type MessageRequest = z.infer<typeof MessageRequestSchema>;

export const MessageResponseSchema = z.object({ ok: z.boolean() }).passthrough();
export type MessageResponse = z.infer<typeof MessageResponseSchema>;

// ---- GET /workers/:id/events ----------------------------------------------

export const EventsQuerySchema = z.object({
  since: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(5000).default(500),
  order: z.enum(["asc", "desc"]).default("desc"),
});
export type EventsQuery = z.infer<typeof EventsQuerySchema>;

// ---- POST /policy/decide ---------------------------------------------------

export const PolicyDecideRequestSchema = z.object({
  worker_id: z.string(),
  tool_name: z.string(),
  input: z.record(z.string(), z.unknown()),
  tool_use_id: z.string().nullable().optional(),
});
export type PolicyDecideRequest = z.infer<typeof PolicyDecideRequestSchema>;

// External callers (hook/gateway) only ever see allow|deny — the daemon
// resolves "ask" internally via the pending-permissions long-poll.
export const PolicyDecideResponseSchema = ExternalDecisionSchema;
export type PolicyDecideResponse = z.infer<typeof PolicyDecideResponseSchema>;

// Internal daemon use can include "ask" — though decide() never returns it
// to a caller; this stays for in-process typing.
export const InternalDecisionSchema = DecisionSchema;

// ---- GET /pending, POST /pending/:id/decision ------------------------------

export const PendingListResponseSchema = z.array(PendingPermissionRowSchema);

export const PendingDecisionRequestSchema = z.object({
  decision: z.enum(["allow", "deny"]),
  reason: z.string().optional(),
  updatedInput: z.record(z.string(), z.unknown()).optional(),
});
export type PendingDecisionRequest = z.infer<typeof PendingDecisionRequestSchema>;

// ---- GET /session ----------------------------------------------------------

export const SessionStatsResponseSchema = z.object({
  sessionStartTs: z.number().nullable(),
  totalCost: z.number(),
  costPerHour: z.number(),
  activeAgents: z.number(),
  totalAgents: z.number(),
  now: z.number(),
});
export type SessionStatsResponse = z.infer<typeof SessionStatsResponseSchema>;

// ---- GET /api/ui-config ----------------------------------------------------

export const ModelPriceSchema = z.object({
  in: z.number().nonnegative(),
  out: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheCreate: z.number().nonnegative(),
});

export const UiConfigResponseSchema = z.object({
  models: z.array(z.string()),
  budgets: z.record(z.string(), z.number()),
  prices: z.record(z.string(), ModelPriceSchema),
  permissions: z.object({ defaultTtlMs: z.number().int().positive() }),
  sse: z.object({ keepaliveMs: z.number().int().positive() }),
});
export type UiConfigResponse = z.infer<typeof UiConfigResponseSchema>;

// ---- GET /pick-directory, POST /fs/open, GET /fs/default-app ----------------

export const PickDirectoryResponseSchema = z.union([
  z.object({ path: z.string() }),
  z.object({ cancelled: z.literal(true) }),
]);

export const FsOpenRequestSchema = z.object({ path: z.string() });

export const DefaultAppResponseSchema = z.object({
  app: z
    .object({
      bundleId: z.string(),
      bundlePath: z.string(),
      appName: z.string(),
      iconUrl: z.string().nullable(),
    })
    .nullable(),
});

// ---- GET /fs/branches ------------------------------------------------------

export const BranchesQuerySchema = z.object({ cwd: z.string().min(1) });
export type BranchesQuery = z.infer<typeof BranchesQuerySchema>;

export const BranchesResponseSchema = z.object({
  branches: z.array(z.string()),
  current: z.string().nullable(),
});
export type BranchesResponse = z.infer<typeof BranchesResponseSchema>;

// ---- GET /fs/recents -------------------------------------------------------

export const RecentsResponseSchema = z.object({ paths: z.array(z.string()) });
export type RecentsResponse = z.infer<typeof RecentsResponseSchema>;

// ---- POST /fs/reveal -------------------------------------------------------

export const FsRevealRequestSchema = z.object({ path: z.string() });
export type FsRevealRequest = z.infer<typeof FsRevealRequestSchema>;

// ---- GET /fs/read ----------------------------------------------------------

export const FsReadQuerySchema = z.object({ path: z.string().min(1) });
export type FsReadQuery = z.infer<typeof FsReadQuerySchema>;

export const FsReadResponseSchema = z.object({
  path: z.string(),
  content: z.string(),
  lines: z.number().int().nonnegative(),
});
export type FsReadResponse = z.infer<typeof FsReadResponseSchema>;

// ---- POST /fs/write --------------------------------------------------------

export const FsWriteRequestSchema = z.object({
  path: z.string(),
  content: z.string(),
});
export type FsWriteRequest = z.infer<typeof FsWriteRequestSchema>;

// ---- PUT /workers/:id/permission -------------------------------------------

export const SetPermissionRequestSchema = z.object({ mode: PermissionModeSchema });
export type SetPermissionRequest = z.infer<typeof SetPermissionRequestSchema>;

export const SetPermissionResponseSchema = z.object({
  ok: z.boolean(),
  mode: PermissionModeSchema,
  runtimeApplied: z.boolean(),
});
export type SetPermissionResponse = z.infer<typeof SetPermissionResponseSchema>;

// ---- PUT /workers/:id/model ------------------------------------------------

export const SetModelRequestSchema = z.object({
  model: z.string().min(1),
  effort: z.string().optional(),
});
export type SetModelRequest = z.infer<typeof SetModelRequestSchema>;

export const SetModelResponseSchema = z.object({
  ok: z.boolean(),
  model: z.string(),
  effort: z.string().nullable(),
  runtimeApplied: z.boolean(),
});
export type SetModelResponse = z.infer<typeof SetModelResponseSchema>;

// ---- GET /workers/:id/diff -------------------------------------------------

export const WorkerDiffResponseSchema = z.object({
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
});
export type WorkerDiffResponse = z.infer<typeof WorkerDiffResponseSchema>;

// ---- GET /commands ---------------------------------------------------------

export const CommandsQuerySchema = z.object({ cwd: z.string().optional() });
export type CommandsQuery = z.infer<typeof CommandsQuerySchema>;

export const CommandItemSchema = z.object({
  name: z.string(),
  description: z.string(),
  source: z.enum(["user", "project", "skill", "plugin"]),
  argumentHint: z.string().optional(),
});
export type CommandItem = z.infer<typeof CommandItemSchema>;

export const CommandsResponseSchema = z.object({
  commands: z.array(CommandItemSchema),
});
export type CommandsResponse = z.infer<typeof CommandsResponseSchema>;

// ---- POST /workers/:id/report ----------------------------------------------

export const ReportRequestSchema = z.object({ text: z.string().min(1) });
export type ReportRequest = z.infer<typeof ReportRequestSchema>;

// ---- PUT /workers/:id/name -------------------------------------------------

export const SetNameRequestSchema = z.object({ name: z.string().nullable() });
export type SetNameRequest = z.infer<typeof SetNameRequestSchema>;

// ---- error envelope --------------------------------------------------------

export const ErrorResponseSchema = z.object({
  error: z.string(),
  // Endpoints may attach a request id when the error happened mid-route.
  request_id: z.string().optional(),
}).passthrough();
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// ---- routes table (paths used by clients) ----------------------------------
//
// Centralizing endpoint paths here means a typo in one consumer is caught at
// compile time. The string literals on the daemon side (route matchers) and
// on the client side (fetch URLs) both reference these constants.

export const ROUTES = {
  health: "/health",
  stream: "/stream",
  workers: "/workers",
  worker: (id: string): string => `/workers/${id}`,
  workerEvents: (id: string): string => `/workers/${id}/events`,
  workerMessage: (id: string): string => `/workers/${id}/message`,
  orchestrators: "/orchestrators",
  orchestratorMessage: (id: string): string => `/orchestrators/${id}/message`,
  policyDecide: "/policy/decide",
  pending: "/pending",
  pendingDecision: (id: string): string => `/pending/${id}/decision`,
  session: "/session",
  metrics: "/metrics",
  uiConfig: "/api/ui-config",
  pickDirectory: "/pick-directory",
  fsDefaultApp: "/fs/default-app",
  fsOpen: "/fs/open",
  fsIcon: "/fs/icon",
  fsBranches: "/fs/branches",
  fsRecents: "/fs/recents",
  fsReveal: "/fs/reveal",
  fsRead: "/fs/read",
  fsWrite: "/fs/write",
  workerName: (id: string): string => `/workers/${id}/name`,
  workerPermission: (id: string): string => `/workers/${id}/permission`,
  workerModel: (id: string): string => `/workers/${id}/model`,
  workerDiff: (id: string): string => `/workers/${id}/diff`,
  workerInterrupt: (id: string): string => `/workers/${id}/interrupt`,
  workerReport: (id: string): string => `/workers/${id}/report`,
  commands: "/commands",
  notificationsConfig: "/api/notifications/config",
  web: "/web/",
} as const;
