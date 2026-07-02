// The command catalog. Each entry is the single source of truth for one daemon
// operation's wire shape (path + method + schemas). Add a command here, give it
// a handler in manager/commands/handlers/, and the route + every client request
// follow from this def — no path or body is re-spelled per transport.

import { z } from "zod";
import { type CommandDef, NoAddrSchema, NoBodySchema, type NoAddr, type NoBody } from "./types.ts";
import {
  SpawnWorkerRequestSchema,
  SpawnWorkerResponseSchema,
  type SpawnWorkerRequest,
  type SpawnWorkerResponse,
} from "../http.ts";
import {
  WorkflowToolRequestSchema,
  RunWorkflowResultSchema,
  WorkflowDefinitionSchema,
  CreateWorkflowResponseSchema,
  type WorkflowToolRequest,
  type RunWorkflowResult,
  type WorkflowDefinition,
  type CreateWorkflowResponse,
} from "../workflow.ts";

// ---- worker.spawn ----------------------------------------------------------

export const spawnWorkerCommand: CommandDef<NoAddr, SpawnWorkerRequest, SpawnWorkerResponse> = {
  name: "worker.spawn",
  method: "POST",
  pattern: "/workers",
  buildPath: () => "/workers",
  addr: NoAddrSchema,
  data: SpawnWorkerRequestSchema,
  output: SpawnWorkerResponseSchema,
  meta: { summary: "Spawn a worker", mutates: true, scope: "worker" },
};

// ---- worker.kill -----------------------------------------------------------

export const KillWorkerAddrSchema = z.object({
  id: z.string().min(1),
  // The actor performing the kill. When present the daemon enforces ownership
  // (an orchestrator may only kill its own subtree); the operator CLI omits it.
  actorId: z.string().optional(),
});
export type KillWorkerAddr = z.infer<typeof KillWorkerAddrSchema>;

export const KillWorkerResponseSchema = z.object({
  killed: z.array(z.object({ pid: z.number(), via: z.string() })),
  removed: z.boolean(),
  was_state: z.string(),
  id: z.string(),
  name: z.string().nullable(),
});
export type KillWorkerResponse = z.infer<typeof KillWorkerResponseSchema>;

export const killWorkerCommand: CommandDef<KillWorkerAddr, NoBody, KillWorkerResponse> = {
  name: "worker.kill",
  method: "DELETE",
  pattern: /^\/workers\/(?<id>[^/]+)$/,
  buildPath: ({ id, actorId }) =>
    `/workers/${encodeURIComponent(id)}` + (actorId ? `?actorId=${encodeURIComponent(actorId)}` : ""),
  addr: KillWorkerAddrSchema,
  data: NoBodySchema,
  output: KillWorkerResponseSchema,
  meta: { summary: "Terminate a worker (SIGTERM + DB row removal)", mutates: true, scope: "worker" },
};

// Reusable addr for any worker-scoped command addressed only by its id.
export const WorkerIdAddrSchema = z.object({ id: z.string().min(1) });
export type WorkerIdAddr = z.infer<typeof WorkerIdAddrSchema>;

// ---- worker.archive / worker.restore / worker.purge -------------------------
// HTTP-only operator surface (ADR-3 amendment): archived workers are invisible
// to agents, so NO MCP tool is ever built from these defs — consumers are the
// dashboard Archive view and the CLI. Archive stops the process and stamps the
// subtree reversibly; restore flips it back; purge is the destructive cascade
// (kill semantics) allowed only on already-archived rows.

export const ArchiveWorkerResponseSchema = z.object({
  id: z.string(),
  // Subtree ids stamped, depth-first order.
  archived: z.array(z.string()),
  was_state: z.string(),
});
export type ArchiveWorkerResponse = z.infer<typeof ArchiveWorkerResponseSchema>;

export const RestoreWorkerResponseSchema = z.object({
  id: z.string(),
  restored: z.array(z.string()),
});
export type RestoreWorkerResponse = z.infer<typeof RestoreWorkerResponseSchema>;

export const PurgeWorkerResponseSchema = z.object({
  id: z.string(),
  removed: z.literal(true),
  name: z.string().nullable(),
});
export type PurgeWorkerResponse = z.infer<typeof PurgeWorkerResponseSchema>;

export const archiveWorkerCommand: CommandDef<KillWorkerAddr, NoBody, ArchiveWorkerResponse> = {
  name: "worker.archive",
  method: "POST",
  pattern: /^\/workers\/(?<id>[^/]+)\/archive$/,
  buildPath: ({ id, actorId }) =>
    `/workers/${encodeURIComponent(id)}/archive` + (actorId ? `?actorId=${encodeURIComponent(actorId)}` : ""),
  addr: KillWorkerAddrSchema,
  data: NoBodySchema,
  output: ArchiveWorkerResponseSchema,
  meta: { summary: "Archive a worker subtree (stop process, keep rows/worktree)", mutates: true, scope: "worker" },
};

export const restoreWorkerCommand: CommandDef<WorkerIdAddr, NoBody, RestoreWorkerResponse> = {
  name: "worker.restore",
  method: "POST",
  pattern: /^\/workers\/(?<id>[^/]+)\/restore$/,
  buildPath: ({ id }) => `/workers/${encodeURIComponent(id)}/restore`,
  addr: WorkerIdAddrSchema,
  data: NoBodySchema,
  output: RestoreWorkerResponseSchema,
  meta: { summary: "Restore an archived worker subtree to the live list", mutates: true, scope: "worker" },
};

export const purgeWorkerCommand: CommandDef<KillWorkerAddr, NoBody, PurgeWorkerResponse> = {
  name: "worker.purge",
  method: "DELETE",
  pattern: /^\/workers\/(?<id>[^/]+)\/purge$/,
  buildPath: ({ id, actorId }) =>
    `/workers/${encodeURIComponent(id)}/purge` + (actorId ? `?actorId=${encodeURIComponent(actorId)}` : ""),
  addr: KillWorkerAddrSchema,
  data: NoBodySchema,
  output: PurgeWorkerResponseSchema,
  meta: { summary: "Permanently delete an archived worker subtree", mutates: true, scope: "worker" },
};

// ---- worker.interrupt ------------------------------------------------------

// Either the success shape or the standard {error} body (404 gone / 409 not
// running). The handler returns the exact body, so the contract stays honest.
export const InterruptWorkerResponseSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ error: z.string() }),
]);
export type InterruptWorkerResponse = z.infer<typeof InterruptWorkerResponseSchema>;

export const interruptWorkerCommand: CommandDef<WorkerIdAddr, NoBody, InterruptWorkerResponse> = {
  name: "worker.interrupt",
  method: "POST",
  pattern: /^\/workers\/(?<id>[^/]+)\/interrupt$/,
  buildPath: ({ id }) => `/workers/${encodeURIComponent(id)}/interrupt`,
  addr: WorkerIdAddrSchema,
  data: NoBodySchema,
  output: InterruptWorkerResponseSchema,
  meta: { summary: "Interrupt a worker's current turn (Esc)", mutates: true, scope: "worker" },
};

// ---- workflow.run ----------------------------------------------------------
// The single MCP `workflow` tool's dispatch endpoint: one discriminated-union
// body (run-stored / run-inline / status / stop / create) posted to /workflows;
// the handler branches on `mode`. Handler lands in a later phase.

export const runWorkflowCommand: CommandDef<NoAddr, WorkflowToolRequest, RunWorkflowResult> = {
  name: "workflow.run",
  method: "POST",
  pattern: "/workflows",
  buildPath: () => "/workflows",
  addr: NoAddrSchema,
  data: WorkflowToolRequestSchema,
  output: RunWorkflowResultSchema,
  meta: { summary: "Run / control a workflow", mutates: true, scope: "orchestrator" },
};

// ---- workflow.create -------------------------------------------------------
// The sibling `create_workflow` tool: persist a definition for reuse (owner+name
// UPSERT, mirrors create_worker). PUT is the idempotent upsert-by-name; POST
// /workflows is reserved for starting a run.

export const createWorkflowCommand: CommandDef<NoAddr, WorkflowDefinition, CreateWorkflowResponse> = {
  name: "workflow.create",
  method: "PUT",
  pattern: "/workflows",
  buildPath: () => "/workflows",
  addr: NoAddrSchema,
  data: WorkflowDefinitionSchema,
  output: CreateWorkflowResponseSchema,
  meta: { summary: "Create (persist) a workflow definition", mutates: true, scope: "orchestrator" },
};

// ---- registry --------------------------------------------------------------

export const COMMANDS = [
  spawnWorkerCommand,
  killWorkerCommand,
  archiveWorkerCommand,
  restoreWorkerCommand,
  purgeWorkerCommand,
  interruptWorkerCommand,
  runWorkflowCommand,
  createWorkflowCommand,
] as const;

export const commandByName: ReadonlyMap<string, CommandDef<unknown, unknown, unknown>> = new Map(
  COMMANDS.map((c) => [c.name, c as unknown as CommandDef<unknown, unknown, unknown>]),
);
