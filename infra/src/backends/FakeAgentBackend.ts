// FakeAgentBackend — an in-memory AgentBackend double. It is the conformance
// harness every real adapter is checked against, and lets the daemon + use-cases
// be tested without spawning a real PTY/claude. No Node deps.

import type {
  AgentBackend,
  AgentSession,
  AgentStartCallbacks,
  AgentCapabilities,
  BackendDescriptor,
  WorkerHandle,
} from "../../../core/src/ports/AgentBackend.ts";

export interface FakeSessionRecord {
  workerId: string;
  messages: string[];
  keystrokes: string[];
  interrupts: number;
  clears: number;
  stopped: boolean;
}

const FAKE_CAPS: AgentCapabilities = {
  interrupt: true,
  keystroke: true,
  rewind: false,
  runtimeModelSwitch: false,
  runtimePermissionSwitch: false,
  contextClear: true,
};

const FAKE_DESCRIPTOR: BackendDescriptor = {
  kind: "fake", label: "Fake", processModel: "in-process", billing: "subscription",
  modelSource: "request", capabilities: FAKE_CAPS, models: { kind: "claude" }, auth: "none", enabled: false,
  sessionStore: "none",
};

export interface FakeAgentBackend extends AgentBackend {
  readonly sessions: Map<string, FakeSessionRecord>;
  /** Simulate the session exiting — fires the onExit callback and flips isAlive. */
  exit(workerId: string, code?: number): void;
}

export function createFakeAgentBackend(): FakeAgentBackend {
  const sessions = new Map<string, FakeSessionRecord>();
  const exits = new Map<string, (code: number | null) => void>();
  const alive = new Map<string, boolean>();

  const recordFor = (workerId: string): FakeSessionRecord => {
    let rec = sessions.get(workerId);
    if (!rec) {
      rec = { workerId, messages: [], keystrokes: [], interrupts: 0, clears: 0, stopped: false };
      sessions.set(workerId, rec);
    }
    return rec;
  };

  const makeSession = (workerId: string, handle: WorkerHandle): AgentSession => {
    const rec = recordFor(workerId);
    return {
      workerId,
      handle,
      capabilities: FAKE_CAPS,
      async sendMessage(text: string) {
        rec.messages.push(text);
        return { ok: true, status: 200, body: { ok: true } };
      },
      async sendKeystroke(keys: string) {
        rec.keystrokes.push(keys);
        return { ok: true };
      },
      async interrupt() {
        rec.interrupts++;
        return { ok: true };
      },
      async clearContext() {
        rec.clears++;
        rec.messages = [];
        return { ok: true };
      },
      async setModel() { return { ok: false, reason: "runtime model switch unsupported" }; },
      stop() {
        rec.stopped = true;
        alive.set(workerId, false);
      },
      isAlive() {
        return alive.get(workerId) ?? false;
      },
    };
  };

  return {
    kind: "fake",
    descriptor: FAKE_DESCRIPTOR,
    async start(spec, cb?: AgentStartCallbacks): Promise<AgentSession> {
      const rec = recordFor(spec.workerId);
      if (spec.prompt) rec.messages.push(spec.prompt);
      alive.set(spec.workerId, true);
      if (cb?.onExit) exits.set(spec.workerId, cb.onExit);
      const handle: WorkerHandle = { kind: "inproc", ref: spec.workerId };
      cb?.onSpawn?.(handle);
      return makeSession(spec.workerId, handle);
    },
    attach(workerId, handle): AgentSession {
      if (!alive.has(workerId)) alive.set(workerId, true);
      return makeSession(workerId, handle);
    },
    sessions,
    exit(workerId: string, code = 0): void {
      alive.set(workerId, false);
      exits.get(workerId)?.(code);
    },
  };
}
