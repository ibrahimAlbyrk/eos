// FakeAgentBackend — an in-memory AgentBackend double. It is the conformance
// harness every real adapter is checked against, and lets the daemon + use-cases
// be tested without spawning a real PTY/claude. No Node deps.

import type {
  AgentBackend,
  AgentSession,
  AgentStartCallbacks,
  AgentCapabilities,
  WorkerHandle,
} from "../../../core/src/ports/AgentBackend.ts";

export interface FakeSessionRecord {
  workerId: string;
  messages: string[];
  keystrokes: string[];
  interrupts: number;
  stopped: boolean;
}

const FAKE_CAPS: AgentCapabilities = {
  interrupt: true,
  keystroke: true,
  runtimeModelSwitch: false,
  runtimePermissionSwitch: false,
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

  return {
    kind: "fake",
    start(spec, cb?: AgentStartCallbacks): AgentSession {
      const rec: FakeSessionRecord = {
        workerId: spec.workerId,
        messages: spec.prompt ? [spec.prompt] : [],
        keystrokes: [],
        interrupts: 0,
        stopped: false,
      };
      sessions.set(spec.workerId, rec);
      alive.set(spec.workerId, true);
      if (cb?.onExit) exits.set(spec.workerId, cb.onExit);
      const handle: WorkerHandle = { kind: "inproc", ref: spec.workerId };
      cb?.onSpawn?.(handle);

      return {
        workerId: spec.workerId,
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
        stop() {
          rec.stopped = true;
          alive.set(spec.workerId, false);
        },
        isAlive() {
          return alive.get(spec.workerId) ?? false;
        },
      };
    },
    sessions,
    exit(workerId: string, code = 0): void {
      alive.set(workerId, false);
      exits.get(workerId)?.(code);
    },
  };
}
