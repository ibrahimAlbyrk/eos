// InProcessBackend — an AgentBackend for backends that run INSIDE the daemon
// (no child process): anthropic-api / openai / codex. It drives the Eos-hosted
// ToolRuntime per turn and pushes canonical AgentEvents to cb.onEvent. The model
// + tools + gate are supplied by an env factory (real adapters or, in tests, a
// fake ModelClient — so this is verifiable with no API key / no billing).
//
// Unlike claude-cli (out-of-process, stateless attach via port), in-process
// sessions hold live state (conversation + abort signal) in an in-memory
// registry keyed by workerId; attach() looks them up. (They do not survive a
// daemon restart — the daemon must reconcile orphaned in-process rows on boot.)

import type {
  AgentBackend,
  AgentSession,
  AgentLaunchSpec,
  AgentStartCallbacks,
  AgentCapabilities,
  WorkerHandle,
} from "../../../core/src/ports/AgentBackend.ts";
import type { ModelClient, ModelMessage } from "../../../core/src/ports/ModelClient.ts";
import { runTurn, type RuntimeTool, type ToolGate } from "../../../core/src/use-cases/ToolRuntime.ts";
import type { AgentEvent } from "../../../contracts/src/canonical.ts";

export interface InProcessEnv {
  model: ModelClient;
  tools: Map<string, RuntimeTool>;
  gate: ToolGate;
}
export type InProcessEnvFactory = (spec: AgentLaunchSpec) => InProcessEnv;

interface LiveSession {
  messages: ModelMessage[];
  signal: { aborted: boolean };
  emit(e: AgentEvent): void;
  onExit?: (code: number | null) => void;
  env: InProcessEnv;
  current: Promise<void> | null;
}

// API-style backends: no keystroke channel; interrupt = abort the loop.
const CAPS: AgentCapabilities = {
  interrupt: true,
  keystroke: false,
  runtimeModelSwitch: false,
  runtimePermissionSwitch: false,
};

export interface InProcessBackend extends AgentBackend {
  /** Resolves when the worker's in-flight turn (if any) has settled. For tests
   *  + graceful shutdown. */
  whenSettled(workerId: string): Promise<void>;
}

export function createInProcessBackend(kind: string, envFactory: InProcessEnvFactory): InProcessBackend {
  const live = new Map<string, LiveSession>();

  const kickTurn = (workerId: string, s: LiveSession, userText: string): void => {
    s.signal.aborted = false; // a new turn clears a prior interrupt
    s.messages.push({ role: "user", content: userText });
    const p = runTurn(
      { model: s.env.model, tools: s.env.tools, gate: s.env.gate, emit: s.emit, signal: s.signal },
      s.messages,
    )
      .then((msgs) => { s.messages = msgs; })
      .catch(() => {})
      .finally(() => { if (s.current === p) s.current = null; });
    s.current = p;
  };

  const sessionFor = (workerId: string): AgentSession => ({
    workerId,
    handle: { kind: "inproc", ref: workerId } as WorkerHandle,
    capabilities: CAPS,
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
    stop() {
      const s = live.get(workerId);
      if (!s) return;
      s.signal.aborted = true;
      live.delete(workerId);
      s.emit({ type: "session", phase: "ended", outcome: "killed" });
      s.onExit?.(143);
    },
    isAlive() { return live.has(workerId); },
  });

  return {
    kind,
    async start(spec: AgentLaunchSpec, cb?: AgentStartCallbacks): Promise<AgentSession> {
      const s: LiveSession = {
        messages: [],
        signal: { aborted: false },
        emit: (e) => cb?.onEvent?.(e),
        onExit: cb?.onExit,
        env: envFactory(spec),
        current: null,
      };
      live.set(spec.workerId, s);
      cb?.onSpawn?.({ kind: "inproc", ref: spec.workerId });
      s.emit({ type: "session", phase: "started" });
      if (spec.prompt) kickTurn(spec.workerId, s, spec.prompt);
      return sessionFor(spec.workerId);
    },
    attach(workerId: string): AgentSession {
      return sessionFor(workerId);
    },
    whenSettled(workerId: string): Promise<void> {
      return live.get(workerId)?.current ?? Promise.resolve();
    },
  };
}
