// Fire-and-forget event emitter — POSTs events to the daemon. Failures are
// swallowed so transient daemon hiccups don't crash the worker. The daemon
// will see a gap in the event stream; that's acceptable degradation.

export interface DaemonEventClient {
  emit(type: string, payload?: unknown): void;
}

export function createDaemonEventClient(
  daemonUrl: string | undefined,
  workerId: string | undefined,
): DaemonEventClient {
  if (!daemonUrl || !workerId) {
    // Standalone mode (no daemon) — no-op.
    return { emit(): void {} };
  }
  return {
    emit(type, payload): void {
      fetch(`${daemonUrl}/workers/${workerId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, payload }),
      }).catch(() => {});
    },
  };
}
