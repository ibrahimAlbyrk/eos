// AgentBackend — the backend-agnostic agent execution seam. The claude-cli
// backend (a PTY child reached over HTTP) is the first adapter; anthropic-api /
// claude-sdk / codex follow. This replaces the ProcessSupervisor + PortAllocator
// + WorkerClient + buildArgs cluster as the port that SpawnWorker / KillWorker /
// DispatchMessage depend on. No Node imports (lint dependency direction).

// How the daemon addresses a running session. Out-of-process backends
// (claude-cli) carry a loopback port + child pid; in-process backends carry an
// opaque ref. Replaces the bare `port` + `pid` columns at the call sites.
import type { AgentEvent } from "../../../contracts/src/canonical.ts";
import type { MessageRecord } from "./WorkerClient.ts";

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
  // Backend-specific extras the claude-cli adapter interprets (mcp config path,
  // gateway flag, …); other backends ignore unknown keys.
  readonly backendOptions?: Readonly<Record<string, unknown>>;
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
}
