// ConcurrencyGate — the in-engine concurrency cap (§3.9). Eos provides none, so
// the engine owns a counting semaphore applied at the leaf-step choke point. The
// `run<T>` wrapper makes release exception-safe (the permit returns even if the
// wrapped work throws). The pure impl is CountingSemaphore in core/src/workflow/.

export interface ConcurrencyGate {
  run<T>(fn: () => Promise<T>): Promise<T>;
}
