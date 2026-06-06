// AgentBackend — the backend-agnostic agent execution seam. The claude-cli
// backend (a PTY child reached over HTTP) is the first adapter; anthropic-api /
// claude-sdk / codex follow. This replaces the ProcessSupervisor + PortAllocator
// + WorkerClient + buildArgs cluster as the port that SpawnWorker / KillWorker /
// DispatchMessage depend on. No Node imports (lint dependency direction).

// How the daemon addresses a running session. Out-of-process backends
// (claude-cli) carry a loopback port + child pid; in-process backends carry an
// opaque ref. Replaces the bare `port` + `pid` columns at the call sites.
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
}

export interface AgentSession {
  readonly workerId: string;
  readonly handle: WorkerHandle;
  readonly capabilities: AgentCapabilities;
  // Deliver a user/orchestrator message (a new turn). Resolves when the backend
  // has accepted it, not when the turn completes (observed via the event stream).
  sendMessage(text: string): Promise<{ ok: boolean; status: number; body: unknown }>;
  sendKeystroke(keys: string): Promise<{ ok: boolean }>;
  interrupt(): Promise<{ ok: boolean; reason?: string }>;
  // Graceful stop → forced kill after graceMs. Idempotent.
  stop(graceMs?: number): void;
  isAlive(): boolean;
}

export interface AgentBackend {
  readonly kind: string; // "claude-cli" | "anthropic-api" | …
  start(spec: AgentLaunchSpec, cb?: AgentStartCallbacks): AgentSession;
}

// Multi-backend selection — resolves a profile's kind to its adapter.
export interface AgentBackendRegistry {
  get(kind: string): AgentBackend; // throws on unknown kind
  has(kind: string): boolean;
}
