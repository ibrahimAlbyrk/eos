// A resettable exactly-once latch for per-worker context-threshold notifications.
// The threshold watcher fires the 90%/full heads-up at most once per crossing:
// mark() returns true ONLY the first time a (worker, stage) is recorded, so a
// repeated IDLE edge at the same occupancy is a guaranteed no-op. clear() re-arms
// every stage for a worker when its context epoch resets (a /clear or a fresh
// session drops occupancy back to 0), so the next fill can warn/suspend again.
export interface ContextMarkRepo {
  /** Records the (worker, stage) latch. Returns true only on the first mark. */
  mark(workerId: string, stage: "warn90" | "full"): boolean;
  /** Drops every stage latch for a worker (context epoch reset). */
  clear(workerId: string): void;
  /** True once the (worker, stage) latch has been marked (and not cleared). */
  has(workerId: string, stage: string): boolean;
}
