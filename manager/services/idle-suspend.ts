// Idle suspend. A chat whose session has sat IDLE for IDLE_SUSPEND_MS is
// suspended: its agent process (a few hundred MB each) is closed, the row stays
// SUSPENDED and the next message, side question or warm-up resumes the same
// session. Anything that still needs the live process keeps it up; the check
// then waits another full idle period.

export const IDLE_SUSPEND_MS = 15 * 60_000;

export interface IdleSuspendDeps {
  idleMs: number;
  // Why this worker must stay live although it is IDLE, or null to suspend it.
  keepReason(workerId: string): string | null;
  suspend(workerId: string): void;
  // Runs fn after ms; returns a cancel. Never keeps the process alive.
  schedule(fn: () => void, ms: number): () => void;
}

export interface IdleSuspend {
  // The bus handler for "worker:change" ({ workerId, state }).
  onWorkerChange(payload: { workerId?: string; state?: string }): void;
  dispose(): void;
}

export function makeIdleSuspend(deps: IdleSuspendDeps): IdleSuspend {
  const timers = new Map<string, () => void>();

  const cancel = (workerId: string): void => {
    timers.get(workerId)?.();
    timers.delete(workerId);
  };

  const arm = (workerId: string): void => {
    cancel(workerId);
    timers.set(workerId, deps.schedule(() => {
      timers.delete(workerId);
      if (deps.keepReason(workerId) !== null) { arm(workerId); return; }
      deps.suspend(workerId);
    }, deps.idleMs));
  };

  return {
    onWorkerChange(payload) {
      // Payloads without a state are nudges (queued messages, peer pumps), not edges.
      if (!payload?.workerId || !payload.state) return;
      if (payload.state === "IDLE") arm(payload.workerId);
      else cancel(payload.workerId);
    },
    dispose() {
      for (const id of [...timers.keys()]) cancel(id);
    },
  };
}
