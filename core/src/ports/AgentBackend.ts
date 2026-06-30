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
import type { ProviderCapabilities } from "../../../contracts/src/provider-capabilities.ts";
import type { MessageRecord, RewindResult } from "./WorkerClient.ts";
import type { SpawnWorkerSpec } from "../use-cases/SpawnWorker.ts";

export type WorkerHandle =
  | { readonly kind: "http"; readonly port: number; readonly pid: number | null }
  | { readonly kind: "inproc"; readonly ref: string };

// Capability negotiation so callers branch on data, not on instanceof. A bare
// API backend, e.g., has no keystroke channel.
export interface AgentCapabilities {
  readonly interrupt: boolean;
  readonly keystroke: boolean;
  /** True when the backend can rewind its live conversation to a prior user
   *  message (the double-Esc panel). Decoupled from `keystroke` (ISP):
   *  claude-cli realizes it via PTY keystroke choreography, but a future backend
   *  could rewind through a native fork primitive with no raw keystroke channel.
   *  claude-sdk's query() exposes no fork/rewind primitive → false. The rewind
   *  route + UI panel gate on THIS flag, never on backend kind. */
  readonly rewind: boolean;
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
  /** True when the backend can reset its live conversation/context in place (the
   *  `/clear` slash command). claude-cli: native /clear over the PTY; claude-sdk:
   *  restart the query with a fresh session; in-process: drop the message buffer.
   *  Commands gate on this flag, never on kind — a backend without it never gets
   *  clearContext() called. */
  readonly contextClear?: boolean;
  /** True when the backend expands prompt-template `.md` slash-commands itself
   *  (the bundled claude binary does; the in-process lane does not). DispatchMessage
   *  gates an Eos-side template expander on this flag, never on kind. Consumed in M6. */
  readonly expandsSlashTemplates?: boolean;
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
  // Conversation-store format. Backends sharing the SAME non-"none" store write
  // mutually-loadable transcripts (keyed by cwd+session_id), so a running worker
  // can hand its conversation off between them on resume — claude-cli ↔ claude-sdk
  // both drive the bundled claude binary → "claude-transcript". "none" = no
  // resumable store (metered in-process lanes persist no session_id) → never a
  // backend-switch source or target. Consumed by canHandoffBackend (domain).
  // "eos-conversation" is the durable in-process store (JSONL under ~/.eos, landed
  // in M3) — intentionally NOT loadable by the claude lanes, so cross-lane handoff
  // stays correctly blocked.
  readonly sessionStore: "claude-transcript" | "none" | "eos-conversation";
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

// The typed carrier for backend-specific launch extras. `spec` is the
// SpawnWorkerSpec — argv / worktree / gateway / mcp for the claude-cli lane, plus
// the spawn facts the structured lanes also read (DPI prompt assembly, and the
// collaborate peer-mesh opt-in via backendCollaborate); the rest are runtime knobs.
export interface BackendLaunchOptions {
  readonly spec?: SpawnWorkerSpec;
  readonly resume?: string;
  readonly auth?: AuthRef;
  readonly thinking?: unknown;
  readonly params?: Readonly<Record<string, unknown>>;
  // Provider base URL (origin-only, self-host / proxy / Azure) for api-key
  // backends; the in-process env factory resolves the model client against it.
  readonly baseUrl?: string;
  // Declared per-provider quirks, threaded from the resolved profile so the
  // in-process model client reads facts instead of model-name heuristics.
  readonly capabilities?: ProviderCapabilities;
}

// collaborate (the peer-mesh opt-in) is a spawn fact persisted on the
// SpawnWorkerSpec, so every lane resolves it from the one canonical place:
// backendOptions.spec.collaborate. The claude-cli lane reads spec.collaborate
// directly; the structured lanes (claude-sdk, in-process) go through here.
// Reading a separate top-level backendOptions field instead silently dropped the
// peer tools on a collaborate=true worker.
export function backendCollaborate(opts: BackendLaunchOptions | undefined): boolean {
  return opts?.spec?.collaborate === true;
}

// The DPI role, resolved from the same canonical place as collaborate. Used by the
// structured lanes to pick the tool surface (workflow-worker → workflowWorkerDefs).
export function backendRole(opts: BackendLaunchOptions | undefined): string | undefined {
  return opts?.spec?.role;
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
  // Reset the live conversation/context (the `/clear` slash command). Only
  // meaningful when capabilities.contextClear is true — callers gate on that
  // flag. CLI: forward native /clear over the PTY (the TUI rolls the session).
  // claude-sdk: restart the query with a fresh session. in-process: drop the
  // message buffer + clear the abort flag. An incapable session omits it.
  clearContext?(): Promise<{ ok: boolean }>;
  // Rewind the live conversation to a prior user message (the double-Esc panel).
  // Only meaningful when capabilities.rewind is true — callers gate on that flag;
  // an incapable session omits BOTH methods. CLI: getRewindTargets reads the
  // transcript; rewind replays the TUI keystroke choreography over the PTY.
  // claude-sdk: query() has no fork primitive, so the session omits them.
  getRewindTargets?(): Promise<{ targets: unknown[] }>;
  rewind?(uuid: string, mode: string): Promise<RewindResult>;
  // Recall the just-sent user turn (interrupt before the agent responded): roll
  // back the live conversation to the entry BEFORE the recalled message so it
  // leaks into neither the next turn nor a resume. claude-sdk: relaunch the
  // query on a transcript sliced to the last assistant uuid (forkSession), like
  // the /clear relaunch but resuming the sliced session instead of starting
  // empty. Only meaningful on a lane where the daemon owns the user_message row
  // (!reportsMessageEvents); incapable backends omit it (the interrupt handler
  // gates on the method's presence — ISP, never on backend kind).
  recallLastUserTurn?(): Promise<{ ok: boolean; reason?: string }>;
  // Switch the model (and optional effort) for subsequent turns on the LIVE
  // session. Only meaningful when capabilities.runtimeModelSwitch is true —
  // callers gate on that flag; an incapable session may no-op. LIVE in-session
  // effort switching has no lever (claude-sdk: start()/resume apply effort via
  // Options.effort, but no runtime switch) — persisted regardless by the caller.
  setModel(model: string, effort?: string | null): Promise<{ ok: boolean; reason?: string }>;
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
