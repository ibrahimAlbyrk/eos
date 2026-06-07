// Daemon HTTP API surface — request/response schemas for every endpoint.
// Every route module on the daemon side parses with these, every CLI/web
// client also parses with these. The TUI singularity bug (calling
// /orchestrator/* singular when daemon exposed /orchestrators plural) would
// not have shipped if these had existed first.

import { z } from "zod";
import { UnknownRecordSchema } from "./shared.ts";
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
    parentId: z.string().optional(),
    permissionMode: PermissionModeSchema.optional(),
    role: z.enum(["git"]).optional(),
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
  permissionMode: PermissionModeSchema.optional(),
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

export const MessageResponseSchema = z.object({ ok: z.boolean() });
export type MessageResponse = z.infer<typeof MessageResponseSchema>;

// ---- POST /workers/:id/action ----------------------------------------------
// Predefined git actions; the daemon resolves each to a full prompt template
// (manager/prompts/) and sends it to the PTY, while the chat shows only the
// short display label.

export const WorkerActionSchema = z.enum(["commit", "commit-push", "pr", "draft-pr"]);
export type WorkerAction = z.infer<typeof WorkerActionSchema>;

export const WorkerActionRequestSchema = z.object({ action: WorkerActionSchema });
export type WorkerActionRequest = z.infer<typeof WorkerActionRequestSchema>;

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
  input: UnknownRecordSchema,
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

// ---- POST /api/policy/rule -------------------------------------------------

export const PolicyRuleRequestSchema = z.object({
  tool: z.string().min(1),
  behavior: z.string().min(1),
});
export type PolicyRuleRequest = z.infer<typeof PolicyRuleRequestSchema>;

export const PolicyRuleResponseSchema = z.object({
  ok: z.boolean(),
  existed: z.boolean().optional(),
});
export type PolicyRuleResponse = z.infer<typeof PolicyRuleResponseSchema>;

// ---- GET /pending, POST /pending/:id/decision ------------------------------

export const PendingListResponseSchema = z.array(PendingPermissionRowSchema);

export const PendingDecisionRequestSchema = z.object({
  decision: z.enum(["allow", "deny"]),
  reason: z.string().optional(),
  updatedInput: UnknownRecordSchema.optional(),
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

export const CatalogModelSchema = z.object({
  id: z.string().min(1),
  displayName: z.string(),
  createdAt: z.string(),
  maxInputTokens: z.number().int().positive().nullable(),
  maxTokens: z.number().int().positive().nullable(),
});
export type CatalogModel = z.infer<typeof CatalogModelSchema>;

export const UiConfigResponseSchema = z.object({
  models: z.array(z.string()),
  modelCatalog: z.array(CatalogModelSchema),
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

// ---- GET /pick-file --------------------------------------------------------

export const PickFileResponseSchema = z.union([
  z.object({ paths: z.array(z.string()) }),
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
  isGit: z.boolean(),
  remoteUrl: z.string().nullable(),
  ahead: z.number().int().nonnegative().nullable(),
  behind: z.number().int().nonnegative().nullable(),
  stash: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
});
export type BranchesResponse = z.infer<typeof BranchesResponseSchema>;

// ---- POST /fs/checkout -----------------------------------------------------

export const FsCheckoutRequestSchema = z.object({
  cwd: z.string().min(1),
  branch: z.string().min(1),
});
export type FsCheckoutRequest = z.infer<typeof FsCheckoutRequestSchema>;

export const FsCheckoutResponseSchema = z.object({ ok: z.boolean() });
export type FsCheckoutResponse = z.infer<typeof FsCheckoutResponseSchema>;

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

// ---- GET /fs/list ----------------------------------------------------------

export const FsListQuerySchema = z.object({
  cwd: z.string().min(1),
  query: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});
export type FsListQuery = z.infer<typeof FsListQuerySchema>;

export const FsEntrySchema = z.object({
  name: z.string(),
  absolutePath: z.string(),
  relativePath: z.string(),
  type: z.enum(["file", "directory"]),
});
export type FsEntry = z.infer<typeof FsEntrySchema>;

export const FsListResponseSchema = z.object({
  entries: z.array(FsEntrySchema),
});
export type FsListResponse = z.infer<typeof FsListResponseSchema>;

// ---- GET /fs/image ---------------------------------------------------------
// Binary response (image bytes); only the query is schematized.

export const FsImageQuerySchema = z.object({ path: z.string().min(1) });
export type FsImageQuery = z.infer<typeof FsImageQuerySchema>;

// ---- POST /fs/write --------------------------------------------------------

export const FsWriteRequestSchema = z.object({
  path: z.string(),
  content: z.string(),
});
export type FsWriteRequest = z.infer<typeof FsWriteRequestSchema>;

// ---- PUT /workers/:id/permission -------------------------------------------

export const SetPermissionRequestSchema = z.object({
  mode: PermissionModeSchema,
  cascade: z.boolean().optional(),
});
export type SetPermissionRequest = z.infer<typeof SetPermissionRequestSchema>;

export const SetPermissionResponseSchema = z.object({
  ok: z.boolean(),
  mode: PermissionModeSchema,
  runtimeApplied: z.boolean(),
  affected: z.array(z.string()),
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

// ---- GET /skills/read ------------------------------------------------------

export const SkillReadQuerySchema = z.object({
  name: z.string().min(1),
  cwd: z.string().optional(),
});
export type SkillReadQuery = z.infer<typeof SkillReadQuerySchema>;

export const SkillReadResponseSchema = z.object({
  name: z.string(),
  path: z.string(),
  content: z.string(),
  source: z.enum(["project", "user", "plugin"]),
  lines: z.number().int().nonnegative(),
});
export type SkillReadResponse = z.infer<typeof SkillReadResponseSchema>;

// ---- /api/templates ---------------------------------------------------------
// User prompt templates (~/.claude-mgr/templates/*.md). Content may contain
// {{label}} tab-stop placeholders the web composer navigates after insert.

export const TemplateNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes only");

export const TemplateSchema = z.object({
  name: TemplateNameSchema,
  description: z.string(),
  content: z.string(),
});
export type Template = z.infer<typeof TemplateSchema>;

export const TemplateListResponseSchema = z.object({
  templates: z.array(TemplateSchema),
});
export type TemplateListResponse = z.infer<typeof TemplateListResponseSchema>;

export const TemplateCreateRequestSchema = z.object({
  name: TemplateNameSchema,
  description: z.string().default(""),
  content: z.string().min(1),
});
export type TemplateCreateRequest = z.infer<typeof TemplateCreateRequestSchema>;

export const TemplateUpdateRequestSchema = z.object({
  description: z.string().default(""),
  content: z.string().min(1),
});
export type TemplateUpdateRequest = z.infer<typeof TemplateUpdateRequestSchema>;

export const TemplateMutationResponseSchema = z.object({ ok: z.boolean() });
export type TemplateMutationResponse = z.infer<typeof TemplateMutationResponseSchema>;

// ---- /api/settings -----------------------------------------------------------
// User UI settings (~/.claude-mgr/settings.json), a flat key→value map. The
// daemon only persists; the web settings registry owns key semantics and
// defaults, so adding a setting is a registry entry — not a contract change.

export const SettingValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()), // e.g. selected tool lists
  z.record(z.string(), z.string()), // e.g. per-tool override maps
]);
export type SettingValue = z.infer<typeof SettingValueSchema>;

export const UserSettingsSchema = z.record(z.string(), SettingValueSchema);
export type UserSettings = z.infer<typeof UserSettingsSchema>;

export const SettingsResponseSchema = z.object({ settings: UserSettingsSchema });
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;

// PUT body — merged into the stored map (shallow), then the full map returns.
export const SettingsPatchRequestSchema = z.object({ settings: UserSettingsSchema });
export type SettingsPatchRequest = z.infer<typeof SettingsPatchRequestSchema>;

// ---- POST /workers/:id/interrupt -------------------------------------------

export const InterruptResponseSchema = z.object({ ok: z.boolean() });
export type InterruptResponse = z.infer<typeof InterruptResponseSchema>;

// ---- POST /workers/:id/report ----------------------------------------------

export const ReportRequestSchema = z.object({ text: z.string().min(1) });
export type ReportRequest = z.infer<typeof ReportRequestSchema>;

export const ReportResponseSchema = z.object({
  ok: z.boolean(),
  delivered: z.boolean().optional(),
});
export type ReportResponse = z.infer<typeof ReportResponseSchema>;

// ---- POST /workers/:id/question-notify -------------------------------------

export const QuestionNotifyRequestSchema = z.object({
  questions: z.array(UnknownRecordSchema),
  toolUseId: z.string().nullish(),
});
export type QuestionNotifyRequest = z.infer<typeof QuestionNotifyRequestSchema>;

export const QuestionNotifyResponseSchema = z.object({ ok: z.boolean() });
export type QuestionNotifyResponse = z.infer<typeof QuestionNotifyResponseSchema>;

// ---- POST /workers/:id/question --------------------------------------------

// The PermissionRequest hook payload carries no tool_use_id (only PreToolUse
// does), so the hook posts null/absent. The daemon synthesizes a stable id
// when it is missing, which the web UI echoes back on answer.
export const QuestionRequestSchema = z.object({
  questions: z.array(UnknownRecordSchema),
  toolUseId: z.string().nullish(),
});
export type QuestionRequest = z.infer<typeof QuestionRequestSchema>;

// ---- POST /workers/:id/question-answer -------------------------------------

export const QuestionAnswerRequestSchema = z.object({
  toolUseId: z.string(),
  answers: z.record(z.string(), z.string()),
});
export type QuestionAnswerRequest = z.infer<typeof QuestionAnswerRequestSchema>;

// ---- POST /workers/:id/notify ----------------------------------------------
//
// Orchestrator-initiated user notification. Published on the event bus as
// `notification:fire`; the native app delivers it when backgrounded.

export const NotifyRequestSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
});
export type NotifyRequest = z.infer<typeof NotifyRequestSchema>;

// ---- PUT /workers/:id/name -------------------------------------------------

export const SetNameRequestSchema = z.object({ name: z.string().nullable() });
export type SetNameRequest = z.infer<typeof SetNameRequestSchema>;

// ---- error envelope --------------------------------------------------------

export const ErrorResponseSchema = z.object({
  error: z.string(),
  request_id: z.string().optional(),
});
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
  workerAction: (id: string): string => `/workers/${id}/action`,
  orchestrators: "/orchestrators",
  orchestratorMessage: (id: string): string => `/orchestrators/${id}/message`,
  policyDecide: "/policy/decide",
  policyRule: "/api/policy/rule",
  pending: "/pending",
  pendingDecision: (id: string): string => `/pending/${id}/decision`,
  session: "/session",
  metrics: "/metrics",
  uiConfig: "/api/ui-config",
  pickDirectory: "/pick-directory",
  pickFile: "/pick-file",
  fsDefaultApp: "/fs/default-app",
  fsOpen: "/fs/open",
  fsIcon: "/fs/icon",
  fsBranches: "/fs/branches",
  fsRecents: "/fs/recents",
  fsReveal: "/fs/reveal",
  fsRead: "/fs/read",
  fsList: "/fs/list",
  fsImage: "/fs/image",
  fsCheckout: "/fs/checkout",
  fsWrite: "/fs/write",
  fsPaste: "/fs/paste",
  workerName: (id: string): string => `/workers/${id}/name`,
  workerPermission: (id: string): string => `/workers/${id}/permission`,
  workerModel: (id: string): string => `/workers/${id}/model`,
  workerDiff: (id: string): string => `/workers/${id}/diff`,
  workerInterrupt: (id: string): string => `/workers/${id}/interrupt`,
  workerKeystroke: (id: string): string => `/workers/${id}/keystroke`,
  workerQuestion: (id: string): string => `/workers/${id}/question`,
  workerQuestionNotify: (id: string): string => `/workers/${id}/question-notify`,
  workerQuestionAnswer: (id: string): string => `/workers/${id}/question-answer`,
  workerNotify: (id: string): string => `/workers/${id}/notify`,
  workerReport: (id: string): string => `/workers/${id}/report`,
  commands: "/commands",
  skillRead: "/skills/read",
  templates: "/api/templates",
  template: (name: string): string => `/api/templates/${name}`,
  settings: "/api/settings",
  web: "/web/",
} as const;
