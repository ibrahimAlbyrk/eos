// AgentBackend — the backend-agnostic agent execution seam. The claude-cli
// backend (a PTY child reached over HTTP) is the first adapter; anthropic-api /
// claude-sdk / codex follow. This replaces the ProcessSupervisor + PortAllocator
// + WorkerClient + buildArgs cluster as the port that SpawnWorker / KillWorker /
// DispatchMessage depend on. No Node imports (lint dependency direction).

// How the daemon addresses a running session. Out-of-process backends
// (claude-cli) carry a loopback port + child pid; in-process backends carry an
// opaque ref. Replaces the bare `port` + `pid` columns at the call sites.
import type { AgentEvent } from "../../../contracts/src/canonical.ts";
import type { AuthRef } from "../../../contracts/src/backend.ts";
import type { MessageRecord } from "./WorkerClient.ts";
import type { SpawnWorkerSpec } from "../use-cases/SpawnWorker.ts";

export type WorkerHandle =
  | { readonly kind: "http"; readonly port: number; readonly pid: number | null }
  | { readonly kind: "inproc"; readonly ref: string };

// Capability negotiation so callers branch on data, not on instanceof. A bare
// API backend, e.g., has no keystroke channel.
export interface AgentCapabilities {
  readonly interrupt: boolean;
  readonly keystroke: boolean;
  readonly runtimeModelSwitch: boolean;
  readonly runtimePermissionSwitch: boolean;
  /** True when the backend emits the user_message/orchestrator_message chat
   *  event itself at transcript-consumption time (claude-cli: the worker's
   *  JSONL tail). False/absent → DispatchMessage appends it at dispatch time,
   *  which cannot be ordered against in-flight turn output. */
  readonly reportsMessageEvents?: boolean;
  /** True when the backend streams interim reasoning/text as `delta` events
   *  (claude-sdk, in-process). The UI gates its live thinking renderer on this
   *  DATA, never on backend kind. claude-cli is absent — whole-block thinking. */
  readonly streamingThinking?: boolean;
  /** True when the session survives a daemon restart via a persisted session id
   *  (claude-sdk: options.resume). Drives boot reconciliation resume-vs-suspend. */
  readonly resumable?: boolean;
}

// What the UI model picker shows for a provider. claude-cli + claude-sdk share
// the Claude /v1/models catalog; metered providers declare their own.
export type ModelCatalogRef =
  | { readonly kind: "claude" }
  | { readonly kind: "static"; readonly models: readonly string[] }
  | { readonly kind: "openai-compatible" };

// Per-kind provider metadata — the SINGLE source for every fact the system used to
// re-derive from the `kind` string. Adding a provider = registering one descriptor
// (+ its adapter); consumers read these properties, never compare kind literals.
export interface BackendDescriptor {
  readonly kind: string;
  readonly label: string;                                   // UI: "Claude SDK"
  readonly processModel: "in-process" | "out-of-process";   // handle kind, liveness, kill/interrupt routing
  readonly billing: "subscription" | "metered";             // cost label, billing guard, creds fallback
  readonly modelSource: "request" | "profile";              // request = composer's model; profile = profile-fixed
  readonly capabilities: AgentCapabilities;                 // UI gates on this, never on kind
  readonly models: ModelCatalogRef;                         // the provider's model catalog (UI picker)
  readonly auth: "subscription" | "apikey" | "none";        // credential it needs (drives creds-absent fallback)
  readonly enabled: boolean;                                 // selectable now vs "soon"
}

// Identity + execution context to start a session. Deliberately free of argv /
// env / port — those are claude-cli adapter internals.
export interface AgentLaunchSpec {
  readonly workerId: string;
  readonly cwd: string;
  readonly model: string;
  readonly effort?: string | null;
  readonly prompt: string;
  readonly systemPromptFile?: string | null;
  readonly permissionMode?: string | null;
  readonly persistent: boolean;
  readonly parentId: string | null;
  readonly isOrchestrator: boolean;
  // Typed backend extras (replaces the former Record<string,unknown> grab-bag).
  // Each adapter reads the fields it understands; the rest are ignored.
  readonly backendOptions?: BackendLaunchOptions;
}

// The typed carrier for backend-specific launch extras. `spec` is the claude-cli
// SpawnWorkerSpec (argv / worktree / gateway / mcp — and the DPI prompt-assembly
// facts the sdk adapter reads); the others are read by the structured backends.
export interface BackendLaunchOptions {
  readonly spec?: SpawnWorkerSpec;
  readonly resume?: string;
  readonly collaborate?: boolean;
  readonly auth?: AuthRef;
  readonly thinking?: unknown;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface AgentStartCallbacks {
  onSpawn?(handle: WorkerHandle): void;
  // Called when the session ends with its numeric code (signal → 128+n), or null.
  onExit?(code: number | null): void;
  // Canonical event sink for IN-PROCESS backends, which have no child process /
  // HTTP channel to POST events through. Out-of-process backends (claude-cli)
  // leave this unset and deliver events via their own transport.
  onEvent?(event: AgentEvent): void;
}

export interface AgentSession {
  readonly workerId: string;
  readonly handle: WorkerHandle;
  readonly capabilities: AgentCapabilities;
  // Deliver a user/orchestrator message (a new turn). Resolves when the backend
  // has accepted it, not when the turn completes (observed via the event stream).
  // `record` is only meaningful for backends with reportsMessageEvents.
  sendMessage(text: string, record?: MessageRecord): Promise<{ ok: boolean; status: number; body: unknown }>;
  sendKeystroke(keys: string): Promise<{ ok: boolean }>;
  interrupt(): Promise<{ ok: boolean; reason?: string }>;
  // Graceful stop → forced kill after graceMs. Idempotent.
  stop(graceMs?: number): void;
  isAlive(): boolean;
}

export interface AgentBackend {
  readonly kind: string; // "claude-cli" | "anthropic-api" | …
  readonly descriptor: BackendDescriptor; // provider metadata (consumers branch on this, not on kind)
  // Spawn a NEW session for this spec (may allocate resources, e.g. a port).
  start(spec: AgentLaunchSpec, cb?: AgentStartCallbacks): Promise<AgentSession>;
  // Reconstruct a session for an ALREADY-running worker from its persisted
  // handle (stateless — the daemon re-derives operations on demand, exactly as
  // it does today via the port column; no in-memory session registry). Used by
  // the message / kill / interrupt / keystroke paths.
  attach(workerId: string, handle: WorkerHandle): AgentSession;
}

// Multi-backend selection — resolves a profile's kind to its adapter.
export interface AgentBackendRegistry {
  get(kind: string): AgentBackend; // throws on unknown kind
  has(kind: string): boolean;
  descriptors(): BackendDescriptor[]; // every registered provider's metadata (UI provider list)
}
