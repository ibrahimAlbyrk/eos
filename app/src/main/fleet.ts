// Main-process port of the Swift StatusBar domain (FleetModel + CompletionQueue)
// + the ingestion loop (AgentStatusSource). Pure diff of two /workers snapshots
// so it survives missed/duplicated SSE frames (never trusts an inline payload).

// The seven canonical worker states (contracts events WorkerStateSchema).
const BUSY = new Set(["SPAWNING", "WORKING"]);
const IN_FLIGHT = new Set(["SPAWNING", "WORKING", "ENDING"]);
const SETTLED = new Set(["IDLE", "DONE"]);

export interface AgentSnapshot {
  id: string;
  state: string;
  name: string | null;
  exitCode: number | null;
}

export interface Completion {
  agentId: string;
  name: string;
  failed: boolean;
  summaryCount: number;
}

export interface FleetDiff {
  running: boolean;
  runningCount: number;
  completed: Completion[];
}

function displayName(s: AgentSnapshot): string {
  return s.name && s.name.length > 0 ? s.name : s.id.slice(0, 6);
}

// Pure reducer — a worker "completed" across S(t-1)→S(t) when it was in flight
// and is now settled. prev==null ⇒ seed silently (no completion storm on launch).
export function diffFleet(prev: Map<string, AgentSnapshot> | null, next: AgentSnapshot[]): FleetDiff {
  const runningCount = next.reduce((n, s) => n + (BUSY.has(s.state) ? 1 : 0), 0);
  const running = runningCount > 0;
  if (!prev) return { running, runningCount, completed: [] };
  const completed: Completion[] = [];
  for (const n of next) {
    const p = prev.get(n.id);
    if (!p) continue;
    if (!IN_FLIGHT.has(p.state) || !SETTLED.has(n.state)) continue;
    const failed = n.state === "DONE" && n.exitCode != null && n.exitCode !== 0;
    completed.push({ agentId: n.id, name: displayName(n), failed, summaryCount: 0 });
  }
  return { running, runningCount, completed };
}

export function indexFleet(snaps: AgentSnapshot[]): Map<string, AgentSnapshot> {
  const m = new Map<string, AgentSnapshot>();
  for (const s of snaps) m.set(s.id, s);
  return m;
}

// Sequential completion ticker: FIFO, per-agent coalesce, overflow-to-summary,
// current item always finishes its dwell (doc: CompletionQueue.swift).
export class CompletionQueue {
  private pending: Completion[] = [];
  private currentId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly dwellMs: number,
    private readonly maxVisible: number,
    private readonly onAnnounce: (c: Completion, remaining: number) => void,
    private readonly onDrained: () => void,
  ) {}

  get isPlaying(): boolean {
    return this.currentId !== null;
  }

  ingest(completed: Completion[], presentIds: Set<string>, activeIds: Set<string>): void {
    this.pending = this.pending.filter(
      (c) => !(c.summaryCount === 0 && (activeIds.has(c.agentId) || !presentIds.has(c.agentId))),
    );
    for (const c of completed) {
      const i = this.pending.findIndex((p) => p.agentId === c.agentId);
      if (i >= 0) this.pending[i] = c;
      else this.pending.push(c);
    }
    this.collapseOverflow();
    if (this.currentId === null) this.advance();
  }

  private collapseOverflow(): void {
    if (this.pending.length <= this.maxVisible) return;
    const keep = this.pending.slice(0, this.maxVisible - 1);
    const folded = this.pending.slice(this.maxVisible - 1);
    const anyFailed = folded.some((c) => c.failed);
    this.pending = [
      ...keep,
      { agentId: "__summary__", name: `${folded.length} agents`, failed: anyFailed, summaryCount: folded.length },
    ];
  }

  private advance(): void {
    if (this.timer) clearTimeout(this.timer);
    const item = this.pending.shift();
    if (!item) {
      this.currentId = null;
      this.onDrained();
      return;
    }
    this.currentId = item.agentId;
    this.onAnnounce(item, this.pending.length);
    this.timer = setTimeout(() => this.advance(), this.dwellMs);
  }
}

// Decode a /workers row (snake_case) into the projection the tray reads.
function decodeRow(row: Record<string, unknown>): AgentSnapshot {
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  return {
    id: typeof row.id === "string" ? row.id : "",
    state: typeof row.state === "string" ? row.state : "IDLE",
    name: typeof row.name === "string" ? row.name : null,
    exitCode: num(row.exit_code),
  };
}

export interface FleetCallbacks {
  onRunning: (running: boolean, count: number, connected: boolean) => void;
  onAnnounce: (c: Completion, remaining: number) => void;
  onDrained: (running: boolean, count: number) => void;
}

// Ties the SSE invalidation hints + 4s poll to the reducer + queue, mirroring
// StatusBarCoordinator. Fed refetch triggers from the shared SSE client.
export class FleetFeed {
  private prev: Map<string, AgentSnapshot> | null = null;
  private latest: AgentSnapshot[] = [];
  private connected = false;
  private readonly queue: CompletionQueue;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly cb: FleetCallbacks,
    dwellMs = 4350, // 3× the 1.45s base — kept readable (StatusBarCoordinator.swift:21)
  ) {
    this.queue = new CompletionQueue(
      dwellMs,
      6,
      (c, r) => this.cb.onAnnounce(c, r),
      () => this.cb.onDrained(this.runningCount() > 0, this.runningCount()),
    );
  }

  start(): void {
    void this.refetch();
    this.pollTimer = setInterval(() => void this.refetch(), 4000);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.debounce) clearTimeout(this.debounce);
  }

  // Called by the SSE client on a worker:* frame — debounce a burst (0.12s).
  onWorkerFrame(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.refetch(), 120);
  }

  setConnected(up: boolean): void {
    if (this.connected === up) return;
    this.connected = up;
    if (!up) this.prev = null; // reconnect reseeds silently
    this.cb.onRunning(this.runningCount() > 0, this.runningCount(), up);
  }

  private runningCount(): number {
    return this.latest.reduce((n, s) => n + (BUSY.has(s.state) ? 1 : 0), 0);
  }

  private async refetch(): Promise<void> {
    try {
      const res = await fetch(`${this.base}/workers`, { headers: { "x-eos-ui-token": this.token } });
      if (!res.ok) return;
      const arr = (await res.json()) as Record<string, unknown>[];
      if (!Array.isArray(arr)) return;
      this.ingest(arr.map(decodeRow));
      this.connected = true;
    } catch {
      /* transient — the poll or next frame retries */
    }
  }

  private ingest(snaps: AgentSnapshot[]): void {
    this.latest = snaps;
    const diff = diffFleet(this.prev, snaps);
    const presentIds = new Set(snaps.map((s) => s.id));
    const activeIds = new Set(snaps.filter((s) => IN_FLIGHT.has(s.state)).map((s) => s.id));
    this.queue.ingest(diff.completed, presentIds, activeIds);
    if (!this.queue.isPlaying) this.cb.onRunning(diff.running, diff.runningCount, true);
    this.prev = indexFleet(snaps);
  }
}
