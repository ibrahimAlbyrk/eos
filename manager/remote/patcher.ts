// StatePatcher — folds the bus's worker/pending change topics (they carry only
// ids: { workerId } / { id }) into row changes: debounce a change burst, re-read
// the authoritative list route once, then hand one upsert/remove per dirty row
// to a sink. The phone's sink is the §5.4.2 `patch` frame (an `event` alone left
// its list frozen at bootstrap); the dashboard's is the `state:patch` SSE event,
// so it never re-downloads the whole list on a state ping.
//
// The row payload is EXACTLY the list route's row shape (GET /workers, or the
// sink's own list path) — the same JSON the consumer's bootstrap parses — so a
// patch and a bootstrap row are interchangeable on the consumer side.

import type { EventBus } from "../../core/src/ports/EventBus.ts";
import type { RouteDispatch } from "./dispatch.ts";
import type { WsBridge } from "./WsBridge.ts";

// usage:recorded (cost) and loop:change (the row's loop) change a row without a worker:change.
export const WORKER_TOPICS = ["worker:spawn", "worker:change", "worker:exit", "worker:removed", "usage:recorded", "loop:change"] as const;
export const PENDING_TOPICS = ["pending:created", "pending:resolved", "pending:ttl_expired"] as const;

export interface RowChange {
  resource: "workers" | "pending";
  op: "upsert" | "remove";
  data: unknown; // the list row, or { id } for a remove
}

export interface PatchSink {
  // Anyone to push to? No ⇒ a burst is dropped unread.
  active(): boolean;
  push(changes: RowChange[]): void;
}

// The phone: one `patch` frame per change.
export function bridgeSink(bridge: WsBridge): PatchSink {
  return {
    active: () => bridge.size() > 0,
    push: (changes) => { for (const c of changes) bridge.pushPatch(c.resource, c.op, c.data); },
  };
}

export interface StatePatcherDeps {
  bus: EventBus;
  sink: PatchSink;
  routeDispatch: RouteDispatch;
  // The list routes the rows come from (the dashboard reads brief rows).
  paths?: { workers: string; pending: string };
  debounceMs?: number; // trailing collect window for a change burst (default 150)
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export class StatePatcher {
  private readonly deps: StatePatcherDeps;
  private readonly debounceMs: number;
  private unsubs: Array<() => void> = [];
  private dirtyWorkers = new Set<string>();
  private dirtyPending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(deps: StatePatcherDeps) {
    this.deps = deps;
    this.debounceMs = deps.debounceMs ?? 150;
  }

  start(): void {
    if (this.unsubs.length > 0) return;
    for (const t of WORKER_TOPICS) {
      this.unsubs.push(this.deps.bus.subscribe(t, (msg) => this.mark(this.dirtyWorkers, msg.payload, "workerId")));
    }
    for (const t of PENDING_TOPICS) {
      // pending payloads carry BOTH id (the pending row) and workerId (the asker).
      this.unsubs.push(this.deps.bus.subscribe(t, (msg) => this.mark(this.dirtyPending, msg.payload, "id")));
    }
  }

  stop(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.dirtyWorkers.clear();
    this.dirtyPending.clear();
  }

  private mark(set: Set<string>, payload: unknown, key: "workerId" | "id"): void {
    const id = (payload as Record<string, unknown> | null)?.[key];
    if (typeof id !== "string" || id.length === 0) return;
    set.add(id);
    this.arm();
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.debounceMs);
    this.timer.unref?.();
  }

  // Re-read the list route(s) once per burst, then emit one patch per dirty id:
  // row present ⇒ upsert with the full row, absent ⇒ remove carrying { id }.
  private async flush(): Promise<void> {
    if (this.flushing) return; // the running flush re-arms for anything it missed
    this.flushing = true;
    const workers = [...this.dirtyWorkers];
    const pending = [...this.dirtyPending];
    this.dirtyWorkers.clear();
    this.dirtyPending.clear();
    try {
      if (!this.deps.sink.active()) return; // nobody to push to
      const paths = this.deps.paths ?? { workers: "/workers", pending: "/pending" };
      const changes = [
        ...(workers.length > 0 ? await this.read("workers", paths.workers, workers) : []),
        ...(pending.length > 0 ? await this.read("pending", paths.pending, pending) : []),
      ];
      if (changes.length > 0) this.deps.sink.push(changes);
    } catch (e) {
      this.deps.log?.("state patch flush failed", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.flushing = false;
      if (this.dirtyWorkers.size > 0 || this.dirtyPending.size > 0) this.arm();
    }
  }

  private async read(resource: RowChange["resource"], path: string, ids: string[]): Promise<RowChange[]> {
    const result = await this.deps.routeDispatch({ method: "GET", path, body: {} });
    const rows = "body" in result && Array.isArray(result.body) ? (result.body as Array<Record<string, unknown>>) : [];
    const byId = new Map(rows.filter((r) => typeof r.id === "string").map((r) => [r.id as string, r]));
    return ids.map((id) => {
      const row = byId.get(id);
      return row ? { resource, op: "upsert", data: row } : { resource, op: "remove", data: { id } };
    });
  }
}
