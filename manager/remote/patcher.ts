// StatePatcher — the remote edge's §5.4.2 emitter. The bus's worker/pending
// change topics carry only ids ({ workerId } / { id }), so the phone could never
// keep its list state live from `event` frames alone (that gap is what froze
// worker state at bootstrap on the device). This folds those topics into per-row
// `patch` frames: debounce a change burst, re-read the authoritative list route
// once, then push one upsert/remove per dirty row through the bridge.
//
// The row payload is EXACTLY the GET /workers (or GET /pending) list shape — the
// same JSON the phone's bootstrap parses — so a patch and a bootstrap row are
// interchangeable on the consumer side.

import type { EventBus } from "../../core/src/ports/EventBus.ts";
import type { RouteDispatch } from "./dispatch.ts";
import type { WsBridge } from "./WsBridge.ts";

const WORKER_TOPICS = ["worker:spawn", "worker:change", "worker:exit", "worker:removed"] as const;
const PENDING_TOPICS = ["pending:created", "pending:resolved", "pending:ttl_expired"] as const;

export interface StatePatcherDeps {
  bus: EventBus;
  bridge: WsBridge;
  routeDispatch: RouteDispatch;
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
      if (this.deps.bridge.size() === 0) return; // nobody to push to
      if (workers.length > 0) await this.emit("workers", "/workers", workers);
      if (pending.length > 0) await this.emit("pending", "/pending", pending);
    } catch (e) {
      this.deps.log?.("state patch flush failed", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.flushing = false;
      if (this.dirtyWorkers.size > 0 || this.dirtyPending.size > 0) this.arm();
    }
  }

  private async emit(resource: "workers" | "pending", path: string, ids: string[]): Promise<void> {
    const result = await this.deps.routeDispatch({ method: "GET", path, body: {} });
    const rows = "body" in result && Array.isArray(result.body) ? (result.body as Array<Record<string, unknown>>) : [];
    const byId = new Map(rows.filter((r) => typeof r.id === "string").map((r) => [r.id as string, r]));
    for (const id of ids) {
      const row = byId.get(id);
      if (row) this.deps.bridge.pushPatch(resource, "upsert", row);
      else this.deps.bridge.pushPatch(resource, "remove", { id });
    }
  }
}
