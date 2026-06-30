// InProcessBackend — an AgentBackend for backends that run INSIDE the daemon
// (no child process): anthropic-api / openai / codex. It drives the Eos-hosted
// ToolRuntime per turn and pushes canonical AgentEvents to cb.onEvent. The model
// + tools + gate are supplied by an env factory (real adapters or, in tests, a
// fake ModelClient — so this is verifiable with no API key / no billing).
//
// Unlike claude-cli (out-of-process, stateless attach via port), in-process
// sessions hold live state (conversation + abort signal) in an in-memory
// registry keyed by workerId; attach() looks them up. The LIVE registry does not
// survive a daemon restart — but when durability deps (ConversationStore +
// IdGenerator) are injected, each settled turn is persisted under the session id,
// so the daemon reconciles the orphaned row to SUSPENDED and ResumeWorker revives
// it via start({backendOptions.resume}) — NOT attach (see attach below).

import type {
  AgentBackend,
  AgentSession,
  AgentLaunchSpec,
  AgentStartCallbacks,
  AgentCapabilities,
  BackendDescriptor,
  WorkerHandle,
} from "../../../core/src/ports/AgentBackend.ts";
import type { ModelClient, ModelMessage } from "../../../core/src/ports/ModelClient.ts";
import type { ConversationStore } from "../../../core/src/ports/ConversationStore.ts";
import type { ContextCompactor } from "../../../core/src/ports/ContextCompactor.ts";
import type { IdGenerator } from "../../../core/src/ports/IdGenerator.ts";
import { runTurn, type RuntimeTool, type ToolGate } from "../../../core/src/use-cases/ToolRuntime.ts";
import type { AgentEvent } from "../../../contracts/src/canonical.ts";
import type { ProviderCapabilities } from "../../../contracts/src/provider-capabilities.ts";

export interface InProcessEnv {
  model: ModelClient;
  tools: Map<string, RuntimeTool>;
  gate: ToolGate;
  /** The model's context window (tokens), if declared — drives the ToolRuntime
   *  fail-fast pre-flight guard when no compactor is present. Absent ⇒ no guard. */
  contextWindow?: number;
  /** M4 — declared provider quirks + the ContextCompactor, threaded into the loop so
   *  history near contextWindow is trimmed (turn continues) instead of a raw 400. */
  capabilities?: ProviderCapabilities;
  compactor?: ContextCompactor;
  /** M6 — the bare name of the Skill RuntimeTool on this surface (§5c), forwarded to
   *  the loop so a loaded skill body also surfaces as a canonical skill block. Absent
   *  ⇒ no skill-block emit (tests/conformance, the claude lanes). */
  skillToolName?: string;
  /** Late-bind the per-session emit + abort signal (created here in start(), after
   *  the factory ran). The Task-subagent closure needs them — its child loop shares
   *  the parent abort signal and re-tags child events onto the parent stream — but
   *  they don't exist at factory time. Called once before the first turn; absent on
   *  envs with no session-bound tools (tests, conformance). */
  bindSession?(ctx: { emit(e: AgentEvent): void; signal: { aborted: boolean } }): void;
  /** Tear down per-session resources opened by the factory (the external-MCP
   *  client connections, §5c) at stop(). Best-effort, fire-and-forget; absent on
   *  envs that hold none (tests, conformance). Resume re-runs the factory, so MCP
   *  reconnects there — never reused across a restart. */
  closeSession?(): void | Promise<void>;
}
// The factory may be async: the production factory resolves credentials lazily at
// start() (AuthResolver) and then builds the model client. A sync factory (tests,
// conformance) is equally valid — start() awaits either. Per the design invariant,
// only CREDENTIAL resolution is async; the tool surface stays sync.
export type InProcessEnvFactory = (spec: AgentLaunchSpec) => InProcessEnv | Promise<InProcessEnv>;

// Durability injection seam (MJ7). A conversation outlives any single InProcessEnv
// (rebuilt per start), so the store/ids live here, NOT in InProcessEnv. OPTIONAL —
// tests/conformance pass none → no persistence, no session id, the universal
// invariants stay green. Production passes both (the daemon's ConversationStore +
// the shared IdGenerator the rest of the daemon uses — never Math.random here).
export interface InProcessDeps {
  store?: ConversationStore;
  ids?: IdGenerator;
}

interface LiveSession {
  messages: ModelMessage[];
  signal: { aborted: boolean };
  // Durable session id (resume target). "" when no id source was injected — then
  // nothing is persisted and no `session ready` is emitted.
  sessionId: string;
  emit(e: AgentEvent): void;
  onExit?: (code: number | null) => void;
  env: InProcessEnv;
  current: Promise<void> | null;
}

// API-style backends: no keystroke channel; interrupt = abort the loop.
// contextClear drops the in-memory message buffer (the conversation lives here,
// not in a subprocess) — see clearContext below.
const CAPS: AgentCapabilities = {
  interrupt: true,
  keystroke: false,
  rewind: false,
  runtimeModelSwitch: false,
  runtimePermissionSwitch: false,
  contextClear: true,
};

// Durable in-process kinds persist a session id (ConversationStore) so the worker
// survives a daemon restart — boot reconcile keeps the row SUSPENDED and
// ResumeWorker revives it. The resume route gates on capabilities.resumable
// (workers.ts), never on kind. streamingThinking:true — the loop streams reasoning/
// text deltas (createTurn falls back per profile), so the UI renders live thinking
// (it gates on this flag, never on kind).
const RESUMABLE_CAPS: AgentCapabilities = { ...CAPS, resumable: true, streamingThinking: true };

// Per-kind in-process provider metadata. Adding a metered provider = one entry.
// enabled:true — the metered API lanes are SELECTABLE; the spawn-backend billing
// guard (metered needs a costMode:"billed" profile) is the real safety net, so
// enablement here never causes silent metered billing. sessionStore
// "eos-conversation" = the durable JSONL store (M3) — intentionally NOT loadable by
// the claude lanes, so cross-lane handoff stays correctly blocked; in-process kinds
// share it because they persist dialect-NEUTRAL messages (see ConversationStore).
// wireDialect distinguishes the request dialect so canHandoffBackend blocks a LIVE
// cross-dialect handoff (openai↔anthropic-api) — these share the "eos-conversation"
// store but a transcript carrying one dialect's signed reasoning can't replay on the
// other. Same-dialect (openai↔codex) stays handoffable; resume is per-kind so it is
// unaffected.
const IN_PROCESS_DESCRIPTORS: Record<string, Omit<BackendDescriptor, "kind">> = {
  "anthropic-api": { label: "Anthropic API", processModel: "in-process", billing: "metered", modelSource: "profile", capabilities: RESUMABLE_CAPS, models: { kind: "claude" }, auth: "apikey", enabled: true, sessionStore: "eos-conversation", wireDialect: "anthropic" },
  "openai": { label: "OpenAI API", processModel: "in-process", billing: "metered", modelSource: "profile", capabilities: RESUMABLE_CAPS, models: { kind: "openai-compatible" }, auth: "apikey", enabled: true, sessionStore: "eos-conversation", wireDialect: "openai-chat" },
  "codex": { label: "Codex", processModel: "in-process", billing: "metered", modelSource: "profile", capabilities: RESUMABLE_CAPS, models: { kind: "openai-compatible" }, auth: "apikey", enabled: true, sessionStore: "eos-conversation", wireDialect: "openai-chat" },
};

export interface InProcessBackend extends AgentBackend {
  /** Resolves when the worker's in-flight turn (if any) has settled. For tests
   *  + graceful shutdown. */
  whenSettled(workerId: string): Promise<void>;
}

export function createInProcessBackend(kind: string, envFactory: InProcessEnvFactory, deps: InProcessDeps = {}): InProcessBackend {
  const live = new Map<string, LiveSession>();
  const descriptor: BackendDescriptor = {
    kind,
    ...(IN_PROCESS_DESCRIPTORS[kind] ?? { label: kind, processModel: "in-process", billing: "metered", modelSource: "profile", capabilities: CAPS, models: { kind: "openai-compatible" }, auth: "apikey", enabled: false, sessionStore: "none" }),
  };

  const kickTurn = (workerId: string, s: LiveSession, userText: string): void => {
    s.signal.aborted = false; // a new turn clears a prior interrupt
    s.messages.push({ role: "user", content: userText });
    const p = runTurn(
      { model: s.env.model, tools: s.env.tools, gate: s.env.gate, emit: s.emit, signal: s.signal, contextWindow: s.env.contextWindow, compactor: s.env.compactor, capabilities: s.env.capabilities, skillToolName: s.env.skillToolName },
      s.messages,
    )
      // Persist after each settled turn, at the one place the conversation is
      // already mutated — so an orphaned row can rehydrate on resume. No-op when
      // no store/session id was injected (tests/conformance).
      .then((msgs) => { s.messages = msgs; if (deps.store && s.sessionId) deps.store.save(workerId, s.sessionId, msgs); })
      .catch(() => {})
      .finally(() => { if (s.current === p) s.current = null; });
    s.current = p;
  };

  const sessionFor = (workerId: string): AgentSession => ({
    workerId,
    handle: { kind: "inproc", ref: workerId } as WorkerHandle,
    // Kind-aware: the session reports THIS provider's descriptor capabilities
    // (so streamingThinking/resumable vary per kind), not a single shared constant.
    capabilities: descriptor.capabilities,
    async sendMessage(text: string) {
      const s = live.get(workerId);
      if (!s) return { ok: false, status: 410, body: { error: "session gone" } };
      kickTurn(workerId, s, text);
      return { ok: true, status: 200, body: { ok: true } };
    },
    async sendKeystroke() { return { ok: false }; },
    async interrupt() {
      const s = live.get(workerId);
      if (s) s.signal.aborted = true;
      return { ok: true };
    },
    // /clear: the conversation is the in-memory message buffer — drop it and
    // clear any abort so the next turn starts from an empty context. Emit
    // `cleared` so the FSM resets context/task in place (ProcessAgentSignal),
    // delete the persisted conversation, and roll to a fresh session id so the
    // wiped context is never re-loaded on a later resume (the row's session_id
    // tracks the new id via the follow-up `ready`).
    async clearContext() {
      const s = live.get(workerId);
      if (!s) return { ok: false };
      s.signal.aborted = true;
      s.messages = [];
      s.emit({ type: "session", phase: "cleared" });
      deps.store?.delete(s.sessionId);
      const fresh = deps.ids?.newSessionId();
      if (fresh) {
        s.sessionId = fresh;
        s.emit({ type: "session", phase: "ready", sessionId: fresh });
      }
      return { ok: true };
    },
    // No live model switch (runtimeModelSwitch:false) — the model is fixed by the
    // env factory per session; SetWorkerModel persists the new model for next spawn.
    async setModel() { return { ok: false, reason: "runtime model switch unsupported" }; },
    stop() {
      const s = live.get(workerId);
      if (!s) return;
      s.signal.aborted = true;
      live.delete(workerId);
      // Close session-scoped resources (external-MCP connections). Fire-and-forget:
      // stop() is sync and teardown must never throw or block the ended signal.
      void Promise.resolve(s.env.closeSession?.()).catch(() => {});
      s.emit({ type: "session", phase: "ended", outcome: "killed" });
      s.onExit?.(143);
    },
    isAlive() { return live.has(workerId); },
  });

  return {
    kind,
    descriptor,
    async start(spec: AgentLaunchSpec, cb?: AgentStartCallbacks): Promise<AgentSession> {
      // Await the factory: the production factory resolves credentials (AuthResolver)
      // before building the model client; a sync factory (tests) resolves immediately.
      const env = await envFactory(spec);
      // Resume target ?? a fresh injected id (never Math.random) ?? "" (deps-less:
      // no persistence, no `ready`). On resume, rehydrate the persisted conversation
      // before the first turn so the model continues from the prior context (the
      // resume path carries no boot prompt — ResumeWorker forces the IDLE settle).
      const resume = spec.backendOptions?.resume;
      const sessionId = resume ?? deps.ids?.newSessionId() ?? "";
      const seeded = resume && deps.store ? deps.store.load(resume) : null;
      const s: LiveSession = {
        messages: seeded ?? [],
        signal: { aborted: false },
        sessionId,
        emit: (e) => cb?.onEvent?.(e),
        onExit: cb?.onExit,
        env,
        current: null,
      };
      live.set(spec.workerId, s);
      // Late-bind the per-session emit/signal into any session-scoped tools (the
      // Task subagent closure) before the first turn runs.
      env.bindSession?.({ emit: s.emit, signal: s.signal });
      cb?.onSpawn?.({ kind: "inproc", ref: spec.workerId });
      s.emit({ type: "session", phase: "started" });
      // Publish the durable session id so the daemon persists it on the worker row
      // (ProcessAgentSignal.setSessionId) → boot reconcile keeps the row SUSPENDED.
      if (s.sessionId) s.emit({ type: "session", phase: "ready", sessionId: s.sessionId });
      if (spec.prompt) kickTurn(spec.workerId, s, spec.prompt);
      return sessionFor(spec.workerId);
    },
    // attach is for LIVE workers only (the message/kill/interrupt paths re-derive
    // a session from the in-memory registry). The restart-RESUME path deliberately
    // goes through start({backendOptions.resume}) — NOT attach — so the
    // ConversationStore can rehydrate the conversation (ResumeWorker). After a
    // restart with no `live` entry the returned session's methods 410 and
    // isAlive() honestly reports false (live.has → false); it is never the resume
    // vehicle. Lazy-rehydrating here is not feasible: attach is sync, the env
    // factory is async, and the handle carries no session id to load.
    attach(workerId: string): AgentSession {
      return sessionFor(workerId);
    },
    whenSettled(workerId: string): Promise<void> {
      return live.get(workerId)?.current ?? Promise.resolve();
    },
  };
}
