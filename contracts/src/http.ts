// Daemon HTTP API surface — request/response schemas for every endpoint.
// Every route module on the daemon side parses with these, every CLI/web
// client also parses with these. The TUI singularity bug (calling
// /orchestrator/* singular when daemon exposed /orchestrators plural) would
// not have shipped if these had existed first.

import { z } from "zod";
import { UnknownRecordSchema } from "./shared.ts";
import { WorkerRowSchema, PendingPermissionRowSchema, PermissionModeSchema } from "./worker.ts";
import { DecisionSchema, ExternalDecisionSchema } from "./policy.ts";
import { SessionFactsSchema } from "./prompt.ts";

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
    // Spawn INTO an existing worker's worktree (shared workspace) instead of
    // creating a fresh one. Takes precedence over cwd/worktreeFrom.
    workspaceOf: z.string().optional(),
  })
  .refine((b) => !!(b.cwd || b.worktreeFrom || b.workspaceOf), {
    message: "cwd, worktreeFrom or workspaceOf required",
  });
export type SpawnWorkerRequest = z.infer<typeof SpawnWorkerRequestSchema>;

export const SpawnWorkerResponseSchema = z.object({
  id: z.string(),
  port: z.number().int(),
  // Where the worker actually runs. "worktree" may downgrade to "cwd" when
  // the user disables worktrees (settings: git.spawnWithoutWorktree) — this
  // field is the authoritative outcome, not the request's intent.
  isolation: z.enum(["worktree", "cwd"]).optional(),
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

// clientMsgId: client-generated uuid — the daemon's idempotency key. A retry
// or accidental double-POST with the same id is a silent no-op, so a message
// can never become two turns. queueWhenBusy: dashboard sends set it — a
// message arriving while the worker is WORKING is held in the daemon-side
// queue and dispatched at the next IDLE instead of steering mid-turn.
// MCP/action paths omit both (mid-turn steering stays available to them).
export const MessageRequestSchema = z.object({
  text: z.string().min(1),
  clientMsgId: z.string().min(1).max(128).optional(),
  queueWhenBusy: z.boolean().optional(),
});
export type MessageRequest = z.infer<typeof MessageRequestSchema>;

// Daemon → worker /message body extra: asks the worker to emit the chat event
// for this message itself when the text lands in its transcript JSONL — the
// only channel that carries true conversation order. Absent → control traffic
// (slash commands) that must produce no chat event. displayText: what the
// chat shows instead of the delivered text (action prompt label, a report's
// unwrapped body).
// clientMsgIds: the dashboard message ids this record covers (plural — a
// queue drain combines several into one delivery). Carried back in the
// user_message chat event so the web can reconcile its optimistic bubbles
// by id instead of text-prefix matching.
// sentAt: dispatch wall-clock. Late-emitted records (delivery_unverified
// resolution, interrupt/exit drain) get an event ts AFTER the turn's output;
// the chat sorts the bubble by sentAt so it never renders below output it
// caused.
export const MessageRecordSchema = z.union([
  z.object({ as: z.literal("user_message"), displayText: z.string().optional(), clientMsgIds: z.array(z.string()).optional(), sentAt: z.number().optional() }),
  z.object({ as: z.literal("orchestrator_message"), fromParent: z.string(), parentName: z.string().optional(), sentAt: z.number().optional() }),
  z.object({ as: z.literal("worker_report"), fromWorker: z.string(), workerName: z.string().optional(), displayText: z.string().optional(), sentAt: z.number().optional() }),
]);
export type MessageRecord = z.infer<typeof MessageRecordSchema>;

// queued: held in the daemon queue, will dispatch at next IDLE.
// deduped: same clientMsgId already seen — request was a no-op.
export const MessageResponseSchema = z.object({
  ok: z.boolean(),
  queued: z.boolean().optional(),
  queueId: z.number().optional(),
  deduped: z.boolean().optional(),
});
export type MessageResponse = z.infer<typeof MessageResponseSchema>;

// ---- GET /workers/:id/queue --------------------------------------------------
// Daemon-side message queue (the only queue — the web renders pills from this).

export const QueuedMessageSchema = z.object({
  id: z.number(),
  text: z.string(),
  ts: z.number(),
});
export const WorkerQueueResponseSchema = z.object({
  messages: z.array(QueuedMessageSchema),
});
export type WorkerQueueResponse = z.infer<typeof WorkerQueueResponseSchema>;

// ---- POST /workers/:id/action ----------------------------------------------
// Predefined git actions; the daemon resolves each to a full prompt template
// (manager/prompts/) and sends it to the PTY, while the chat shows only the
// short display label.

export const WorkerActionSchema = z.enum(["commit", "commit-push", "pr", "draft-pr", "verify"]);
export type WorkerAction = z.infer<typeof WorkerActionSchema>;

export const WorkerActionRequestSchema = z.object({ action: WorkerActionSchema });
export type WorkerActionRequest = z.infer<typeof WorkerActionRequestSchema>;

// ---- POST /workers/:id/push ------------------------------------------------
// Deterministic push: the daemon inspects the branch's sync state and runs the
// correct git push variant itself (set-upstream / fast-forward / force-with-lease)
// — no agent turn. `outcome` is the single discriminant the UI maps to a label.

export const PushOutcomeSchema = z.enum([
  "pushed-new",    // no upstream existed → push -u (branch published + tracked)
  "pushed",        // fast-forward push
  "pushed-force",  // diverged (rebase/amend) → push --force-with-lease
  "up-to-date",    // nothing to push
  "behind-only",   // local strictly behind upstream → pull first, never force
  "detached",      // detached HEAD → no branch to push
  "no-remote",     // no remote configured
  "rejected",      // non-fast-forward rejection (remote moved) on a plain push
  "lease-stale",   // force-with-lease rejected (remote moved since last fetch)
  "auth",          // authentication/permission failure
  "failed",        // any other git failure
]);
export type PushOutcome = z.infer<typeof PushOutcomeSchema>;

export const PushResultSchema = z.object({
  outcome: PushOutcomeSchema,
  ok: z.boolean(),
  branch: z.string().nullable(),
  remote: z.string().nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  message: z.string(),
  detail: z.string().optional(),
});
export type PushResult = z.infer<typeof PushResultSchema>;

// ---- GET /workers/:id/push-state -------------------------------------------
// Read-only twin of POST /push: the SAME decidePushPlan verdict the push action
// runs, surfaced so the UI's Push-button visibility shares one source of truth
// instead of re-deriving it from the fork-base diff (which counts committed-
// after-fork work as "dirty" and wrongly hides Push on local-only worktrees).
// `pushable` = the plan would actually push; `hasUncommitted` = working tree is
// dirty (commit before pushing).

export const PushPlanKindSchema = z.enum([
  "set-upstream",
  "fast-forward",
  "force-with-lease",
  "noop",
  "blocked",
]);
export type PushPlanKind = z.infer<typeof PushPlanKindSchema>;

export const PushStateResponseSchema = z.object({
  branch: z.string().nullable(),
  remote: z.string().nullable(),
  hasUpstream: z.boolean(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  kind: PushPlanKindSchema,
  pushable: z.boolean(),
  hasUncommitted: z.boolean(),
});
export type PushStateResponse = z.infer<typeof PushStateResponseSchema>;

// ---- POST /workers/:id/terminal ---------------------------------------------
// User-initiated shell command (composer `!` terminal mode). Runs daemon-side
// in the worker's working dir; output streams over SSE as `terminal:chunk`
// bus messages and the full (capped) record persists as a single `terminal`
// event on completion. UI-token gated — agents holding EOS_DAEMON_URL must
// not get a policy-free exec path.

export const TerminalRunRequestSchema = z.object({ command: z.string().min(1) });
export type TerminalRunRequest = z.infer<typeof TerminalRunRequestSchema>;

export const TerminalRunResponseSchema = z.object({ runId: z.string() });
export type TerminalRunResponse = z.infer<typeof TerminalRunResponseSchema>;

// ---- POST /terminal ----------------------------------------------------------
// Workspace-scoped variant: no agent selected, so the command runs in an
// explicit cwd and nothing persists — output is ephemeral (terminal:chunk /
// terminal:done only). Kill is runId-scoped and shared with worker runs.

export const WorkspaceTerminalRunRequestSchema = z.object({
  cwd: z.string().min(1),
  command: z.string().min(1),
});
export type WorkspaceTerminalRunRequest = z.infer<typeof WorkspaceTerminalRunRequestSchema>;

// ---- POST /workers/:id/open --------------------------------------------------
// Open the agent's working directory (worktree dir when isolated, else cwd)
// in a host app. UI-token gated like /terminal — launching host apps is a UI
// affordance, not an agent capability.

export const OpenInRequestSchema = z.object({ target: z.enum(["vscode", "finder"]) });
export type OpenInRequest = z.infer<typeof OpenInRequestSchema>;

// ---- GET /workers/:id/events ----------------------------------------------

export const EventsQuerySchema = z.object({
  since: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(5000).default(500),
  order: z.enum(["asc", "desc"]).default("desc"),
  // Backward pagination cursor: only rows with id < beforeId (desc order only).
  beforeId: z.coerce.number().int().positive().optional(),
  // Forward delta cursor: only rows with id > afterId, id-ASC (insertion
  // order). The web's SSE fast path pulls just-appended rows with this
  // instead of refetching the whole newest page. Overrides order/beforeId.
  afterId: z.coerce.number().int().nonnegative().optional(),
});
export type EventsQuery = z.infer<typeof EventsQuerySchema>;

// ---- POST /policy/decide ---------------------------------------------------

export const PolicyDecideRequestSchema = z.object({
  worker_id: z.string(),
  tool_name: z.string(),
  input: UnknownRecordSchema,
  tool_use_id: z.string().nullable().optional(),
  // Present when the hook fired inside a subagent — drives the Eos
  // control-tool caller-scope deny.
  agent_id: z.string().nullable().optional(),
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
  // Supported effort levels from the API's capabilities tree. Empty = model
  // has no effort support; null = unknown (pre-upgrade cache, missing field).
  effortLevels: z.array(z.string()).nullable().default(null),
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

// ---- GET /fs/unpushed --------------------------------------------------------
// Commits on the current branch that the upstream doesn't have (@{u}..HEAD).

export const UnpushedCommitSchema = z.object({
  sha: z.string(),
  author: z.string(),
  // Commit time, epoch ms.
  ts: z.number(),
  subject: z.string(),
});
export type UnpushedCommit = z.infer<typeof UnpushedCommitSchema>;

export const UnpushedResponseSchema = z.object({
  commits: z.array(UnpushedCommitSchema),
});
export type UnpushedResponse = z.infer<typeof UnpushedResponseSchema>;

// ---- GET /fs/commit ----------------------------------------------------------
// Full detail of one commit: message body + per-file change list.

export const CommitFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  status: z.enum(["M", "A", "D", "R"]),
  insertions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
});
export type CommitFile = z.infer<typeof CommitFileSchema>;

export const CommitDetailSchema = z.object({
  sha: z.string(),
  author: z.string(),
  ts: z.number(),
  subject: z.string(),
  body: z.string(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  files: z.array(CommitFileSchema),
});
export type CommitDetail = z.infer<typeof CommitDetailSchema>;

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

// Three shapes share this schema: text (content+lines), binary sniffed
// (binary+size, no content), and large text (large+size, no content — too big
// to ship as JSON; the viewer degrades to a size note + external open).
export const FsReadResponseSchema = z.object({
  path: z.string(),
  content: z.string().optional(),
  lines: z.number().int().nonnegative().optional(),
  binary: z.boolean().optional(),
  large: z.boolean().optional(),
  size: z.number().int().nonnegative().optional(),
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

// ---- GET /workers/:id/changes ------------------------------------------------

export const ChangedFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  status: z.enum(["M", "A", "D", "R"]),
  insertions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  untracked: z.boolean(),
  // Embedded per-file patch (?patches=1) — same shape as FileDiffResponse.
  // Absent when not requested, for untracked files, or past the payload
  // budget; consumers fall back to GET /changes/file.
  patch: z.string().optional(),
  binary: z.boolean().optional(),
  truncated: z.boolean().optional(),
});
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

export const WorkerChangesResponseSchema = z.object({
  files: z.array(ChangedFileSchema),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type WorkerChangesResponse = z.infer<typeof WorkerChangesResponseSchema>;

// ---- GET /workers/:id/changes/file -------------------------------------------

export const FileDiffQuerySchema = z.object({
  path: z.string().min(1),
  oldPath: z.string().optional(),
});
export type FileDiffQuery = z.infer<typeof FileDiffQuerySchema>;

export const FileDiffResponseSchema = z.object({
  path: z.string(),
  patch: z.string(),
  binary: z.boolean(),
  truncated: z.boolean(),
});
export type FileDiffResponse = z.infer<typeof FileDiffResponseSchema>;

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

// ---- /api/templates ---------------------------------------------------------
// User prompt templates (~/.eos/templates/*.md). Content may contain
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
// User UI settings (~/.eos/settings.json), a flat key→value map. The
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

// ---- POST /workers/:id/resume -----------------------------------------------

// Revives a dead-but-resumable worker (SUSPENDED, or DONE with a recorded
// session) under the same worker id via `claude --resume <session_id>`.
export const ResumeResponseSchema = z.object({ id: z.string(), port: z.number() });
export type ResumeResponse = z.infer<typeof ResumeResponseSchema>;

// ---- POST /workers/:id/report ----------------------------------------------

export const ReportRequestSchema = z.object({ text: z.string().min(1) });
export type ReportRequest = z.infer<typeof ReportRequestSchema>;

export const ReportResponseSchema = z.object({
  ok: z.boolean(),
  delivered: z.boolean().optional(),
});
export type ReportResponse = z.infer<typeof ReportResponseSchema>;

// ---- POST /workers/:id/question --------------------------------------------
//
// The orchestrator's ask_user MCP tool registers a question for the operator,
// then polls GET /workers/:id/question/:questionId until a terminal state.
// Same question shape as the (disabled) builtin AskUserQuestion so the web
// QuestionBanner renders it unchanged.

export const QuestionOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
});
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

export const QuestionSchema = z.object({
  question: z.string().min(1),
  header: z.string().optional(),
  multiSelect: z.boolean().optional(),
  options: z.array(QuestionOptionSchema).min(1).max(8),
});
export type Question = z.infer<typeof QuestionSchema>;

// The caller has no Claude tool_use_id, so the daemon synthesizes one when
// absent; the web UI echoes it back on answer.
export const QuestionRequestSchema = z.object({
  questions: z.array(QuestionSchema).min(1).max(4),
  toolUseId: z.string().nullish(),
});
export type QuestionRequest = z.infer<typeof QuestionRequestSchema>;

export const QuestionRegisterResponseSchema = z.object({
  questionId: z.string(),
  toolUseId: z.string(),
});
export type QuestionRegisterResponse = z.infer<typeof QuestionRegisterResponseSchema>;

// ---- GET /workers/:id/question/:questionId -----------------------------------

// "gone" = the daemon no longer tracks the question (restart, worker killed,
// or superseded). Always 200 — the poller routes on `status`, not HTTP code.
export const QuestionPollResponseSchema = z.object({
  status: z.enum(["pending", "answered", "dismissed", "gone"]),
  answers: z.record(z.string(), z.string()).optional(),
});
export type QuestionPollResponse = z.infer<typeof QuestionPollResponseSchema>;

// ---- POST /workers/:id/question-answer -------------------------------------

export const QuestionAnswerRequestSchema = z.object({
  toolUseId: z.string(),
  answers: z.record(z.string(), z.string()).optional(),
  // True ⇒ the operator closed the banner without answering; the polling tool
  // returns "dismissed" so the orchestrator unblocks instead of waiting forever.
  dismissed: z.boolean().optional(),
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

// ---- GET /workers/:id/rewind-targets ----------------------------------------
//
// User prompts on the transcript's active branch (parentUuid walk back from
// the tip), oldest first. `upCount` = ↑ presses that reach the entry from the
// TUI rewind panel's bottom "(current)" row.

export const RewindTargetSchema = z.object({
  uuid: z.string(),
  // Raw transcript text (what delivery wrote to the PTY).
  text: z.string(),
  // Pretty form for UI lists — slash commands collapse to "/name args".
  display: z.string(),
  // Transcript ISO timestamp.
  ts: z.string(),
  upCount: z.number().int().positive(),
});
export type RewindTarget = z.infer<typeof RewindTargetSchema>;

export const RewindTargetsResponseSchema = z.object({
  targets: z.array(RewindTargetSchema),
});
export type RewindTargetsResponse = z.infer<typeof RewindTargetsResponseSchema>;

// ---- POST /workers/:id/rewind ------------------------------------------------
//
// Drives Claude's native TUI rewind (Esc Esc → ↑×k → Enter → submenu) via
// verified keystroke choreography. The transcript JSONL is never truncated —
// Claude forks in memory and the next submit branches via parentUuid.

export const RewindModeSchema = z.enum(["conversation", "code", "both"]);
export type RewindMode = z.infer<typeof RewindModeSchema>;

export const RewindRequestSchema = z.object({
  uuid: z.string(),
  mode: RewindModeSchema.default("conversation"),
});
export type RewindRequest = z.infer<typeof RewindRequestSchema>;

export const RewindResponseSchema = z.object({
  ok: z.boolean(),
  uuid: z.string().optional(),
  text: z.string().optional(),
  display: z.string().optional(),
  // Target's 0-based position among active-branch prompts — fallback cut
  // point for the web chat when text matching fails (e.g. action prompts
  // whose user_message event stores only the short displayText).
  index: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});
export type RewindResponse = z.infer<typeof RewindResponseSchema>;

// ---- /workers/:id/try* -------------------------------------------------------
// Unstaged Try: the daemon applies the worker branch's merged result into the
// user's checkout as working-tree-only edits (no index, no merge state), with
// Keep/Discard. Tries STACK — several workers' tries can be active per repo at
// once; state survives daemon restarts and worker deletion. Mutating try
// endpoints require the per-boot UI token header (x-eos-ui-token) so agents
// holding the daemon URL cannot self-apply.

export const ActiveTrySchema = z.object({
  workerId: z.string(),
  branch: z.string(),
  baseHead: z.string(),
  files: z.array(z.string()),
  lockfileChanged: z.boolean(),
  createdAt: z.number(),
});
export type ActiveTry = z.infer<typeof ActiveTrySchema>;

export const TryPreviewResponseSchema = z.object({
  // false = git too old for merge-tree --write-tree (< 2.38) or snapshot failed
  supported: z.boolean(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  conflicts: z.array(z.string()),
  files: z.array(z.string()),
  lockfileChanged: z.boolean(),
  // Bottom (oldest) first.
  activeTries: z.array(ActiveTrySchema),
});
export type TryPreviewResponse = z.infer<typeof TryPreviewResponseSchema>;

export const TryApplyResponseSchema = z.object({
  ok: z.boolean(),
  files: z.array(z.string()).optional(),
  lockfileChanged: z.boolean().optional(),
  reason: z.string().optional(),
  detail: z.string().optional(),
});
export type TryApplyResponse = z.infer<typeof TryApplyResponseSchema>;

// Keep/Discard target a specific layer of the stack — the card's owner, not
// necessarily the worker in the URL (the owner may already be deleted; the
// URL worker only resolves the repo).
export const TryTargetRequestSchema = z.object({ workerId: z.string() });
export type TryTargetRequest = z.infer<typeof TryTargetRequestSchema>;

export const TryDiscardResponseSchema = z.object({
  ok: z.boolean(),
  // user-edited | blocked-by-overlay | no-active-try | git-error
  reason: z.string().optional(),
  // user-edited: files whose post-apply hash no longer matches;
  // blocked-by-overlay: the overlapping files (detail = the upper layer's workerId).
  files: z.array(z.string()).optional(),
  detail: z.string().optional(),
});
export type TryDiscardResponse = z.infer<typeof TryDiscardResponseSchema>;

export const TryKeepResponseSchema = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
});
export type TryKeepResponse = z.infer<typeof TryKeepResponseSchema>;

export const TryStateResponseSchema = z.object({
  // All active layers in the repo, bottom (oldest) first.
  activeTries: z.array(ActiveTrySchema),
  // This worker's try was kept earlier — the UI never re-offers Apply for it.
  kept: z.boolean(),
});
export type TryStateResponse = z.infer<typeof TryStateResponseSchema>;

// ---- PUT /workers/:id/name -------------------------------------------------

export const SetNameRequestSchema = z.object({ name: z.string().nullable() });
export type SetNameRequest = z.infer<typeof SetNameRequestSchema>;

// ---- GET /health -----------------------------------------------------------

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  pid: z.number().int(),
  startedAt: z.number(),
  // sha256 over the backend source set (manager/builder/inputs.ts), computed
  // by the daemon itself at boot. `eos build` compares it against the current
  // tree to decide whether a restart is needed.
  sourceStamp: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// ---- POST /api/ui-reload -----------------------------------------------------
// Broadcasts ui:reload over SSE so connected pages refresh in place — lets a
// web-dist rebuild reach the running app without a quit/reopen. subscribers
// is the SSE client count at broadcast time: 0 means nobody took the signal
// and the caller (eos build) must fall back to relaunching the app.

export const UiReloadResponseSchema = z.object({
  ok: z.literal(true),
  subscribers: z.number().int(),
});
export type UiReloadResponse = z.infer<typeof UiReloadResponseSchema>;

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

// ---- /api/prompts -----------------------------------------------------------
// Prompt catalog + DPI assembly preview (introspection / debug). Lets you
// inspect exactly what the assembler produces for a given spawn scenario before
// the live spawn path is cut over to it.

export const PromptDescriptorSchema = z.object({
  id: z.string(),
  description: z.string().nullable(),
  layer: z.string().nullable(),
  priority: z.number().nullable(),
  conditional: z.boolean(),
  variables: z.array(z.string()),
});
export type PromptDescriptor = z.infer<typeof PromptDescriptorSchema>;

export const PromptCatalogResponseSchema = z.object({
  prompts: z.array(PromptDescriptorSchema),
});

export const PromptPreviewRequestSchema = z.object({
  role: z.enum(["orchestrator", "worker", "git"]).default("worker"),
  parentId: z.string().nullable().default(null),
  name: z.string().default("preview"),
  workerId: z.string().nullable().default(null),
  model: z.string().default("opus"),
  effort: z.string().nullable().default(null),
  permissionMode: z.string().default("default"),
  cwd: z.string().nullable().default(null),
  worktreeDir: z.string().nullable().default(null),
  branch: z.string().nullable().default(null),
  repoRoot: z.string().nullable().default(null),
  isAttached: z.boolean().default(false),
  hasMcp: z.boolean().default(false),
});
export type PromptPreviewRequest = z.infer<typeof PromptPreviewRequestSchema>;

export const PromptPreviewResponseSchema = z.object({
  text: z.string(),
  facts: SessionFactsSchema,
  activeFragmentIds: z.array(z.string()),
});

export const ROUTES = {
  health: "/health",
  stream: "/stream",
  workers: "/workers",
  worker: (id: string): string => `/workers/${id}`,
  workerEvents: (id: string): string => `/workers/${id}/events`,
  workerMessage: (id: string): string => `/workers/${id}/message`,
  workerQueue: (id: string): string => `/workers/${id}/queue`,
  workerQueueItem: (id: string, queueId: number): string => `/workers/${id}/queue/${queueId}`,
  workerAction: (id: string): string => `/workers/${id}/action`,
  workerPush: (id: string): string => `/workers/${id}/push`,
  workerPushState: (id: string): string => `/workers/${id}/push-state`,
  orchestrators: "/orchestrators",
  orchestratorMessage: (id: string): string => `/orchestrators/${id}/message`,
  policyDecide: "/policy/decide",
  policyRule: "/api/policy/rule",
  pending: "/pending",
  pendingDecision: (id: string): string => `/pending/${id}/decision`,
  metrics: "/metrics",
  uiConfig: "/api/ui-config",
  uiReload: "/api/ui-reload",
  pickDirectory: "/pick-directory",
  pickFile: "/pick-file",
  fsDefaultApp: "/fs/default-app",
  fsOpen: "/fs/open",
  fsIcon: "/fs/icon",
  fsBranches: "/fs/branches",
  fsUnpushed: "/fs/unpushed",
  fsCommit: "/fs/commit",
  fsRecents: "/fs/recents",
  fsReveal: "/fs/reveal",
  fsRead: "/fs/read",
  fsList: "/fs/list",
  fsImage: "/fs/image",
  // On the raw-content listener (daemon.rawPort), not the main API port:
  fsRaw: "/fs/raw",
  pdfjs: "/pdfjs",
  fsCheckout: "/fs/checkout",
  fsWrite: "/fs/write",
  fsPaste: "/fs/paste",
  workerName: (id: string): string => `/workers/${id}/name`,
  workerOpen: (id: string): string => `/workers/${id}/open`,
  workerPermission: (id: string): string => `/workers/${id}/permission`,
  workerModel: (id: string): string => `/workers/${id}/model`,
  workerDiff: (id: string): string => `/workers/${id}/diff`,
  workerChanges: (id: string): string => `/workers/${id}/changes`,
  workerFileDiff: (id: string): string => `/workers/${id}/changes/file`,
  workerInterrupt: (id: string): string => `/workers/${id}/interrupt`,
  workerResume: (id: string): string => `/workers/${id}/resume`,
  workerKeystroke: (id: string): string => `/workers/${id}/keystroke`,
  workerQuestion: (id: string): string => `/workers/${id}/question`,
  workerQuestionPoll: (id: string, questionId: string): string => `/workers/${id}/question/${questionId}`,
  workerQuestionAnswer: (id: string): string => `/workers/${id}/question-answer`,
  workerNotify: (id: string): string => `/workers/${id}/notify`,
  workerReport: (id: string): string => `/workers/${id}/report`,
  workerRewindTargets: (id: string): string => `/workers/${id}/rewind-targets`,
  workerRewind: (id: string): string => `/workers/${id}/rewind`,
  workerTerminal: (id: string): string => `/workers/${id}/terminal`,
  terminal: "/terminal",
  terminalKill: (runId: string): string => `/terminal/${runId}/kill`,
  workerTryPreview: (id: string): string => `/workers/${id}/try/preview`,
  workerTryState: (id: string): string => `/workers/${id}/try/state`,
  workerTry: (id: string): string => `/workers/${id}/try`,
  workerTryKeep: (id: string): string => `/workers/${id}/try/keep`,
  workerTryDiscard: (id: string): string => `/workers/${id}/try/discard`,
  commands: "/commands",
  templates: "/api/templates",
  template: (name: string): string => `/api/templates/${name}`,
  prompts: "/api/prompts",
  promptPreview: "/api/prompts/preview",
  settings: "/api/settings",
  web: "/web/",
} as const;
