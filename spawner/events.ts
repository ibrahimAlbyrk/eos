// Ordered, acknowledged event emitter — POSTs events to the daemon through a
// FIFO queue with a single in-flight request. The old fire-and-forget client
// allowed concurrent POSTs to complete out of order (hook Stop overtaking
// trailing jsonl) and dropped events silently on any transient failure; this
// one preserves emission order, retries with backoff, and stamps each event
// with a monotonic seq so the daemon can spot gaps.
//
// Delivery is still best-effort past the retry budget — a daemon outage longer
// than the backoff window drops the event (logged), which is the same
// degradation as before, just bounded and visible.

export interface DaemonEventClient {
  emit(type: string, payload?: unknown): void;
  /** Best-effort flush for the exit path; resolves when the queue is empty or
   *  the timeout elapses, whichever comes first. */
  drain(timeoutMs: number): Promise<void>;
}

const RETRY_BACKOFF_MS = [250, 500, 1000];
// Bounds memory if the daemon is down for a long stretch; oldest events drop
// first (they are also the least actionable by the time it recovers).
const QUEUE_CAP = 5000;

export interface EventClientOptions {
  fetchFn?: typeof fetch;
  setTimer?: typeof setTimeout;
  log?(msg: string): void;
  /** Test override for the retry backoff schedule. */
  backoffMs?: number[];
}

export function createDaemonEventClient(
  daemonUrl: string | undefined,
  workerId: string | undefined,
  opts: EventClientOptions = {},
): DaemonEventClient {
  if (!daemonUrl || !workerId) {
    // Standalone mode (no daemon) — no-op.
    return { emit(): void {}, drain: () => Promise.resolve() };
  }
  const fetchFn = opts.fetchFn ?? fetch;
  const setT = opts.setTimer ?? setTimeout;
  const backoffs = opts.backoffMs ?? RETRY_BACKOFF_MS;
  const log = opts.log ?? ((m: string): void => { console.error(m); });
  const url = `${daemonUrl}/workers/${workerId}/events`;

  const queue: string[] = [];
  let seq = 0;
  let pumping = false;
  let idleResolvers: Array<() => void> = [];

  const sleep = (ms: number): Promise<void> => new Promise((r) => { setT(r, ms); });

  async function postOnce(body: string): Promise<boolean> {
    try {
      const r = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      return r.ok;
    } catch {
      return false;
    }
  }

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length > 0) {
        const body = queue[0];
        let sent = await postOnce(body);
        for (let i = 0; !sent && i < backoffs.length; i++) {
          await sleep(backoffs[i]);
          sent = await postOnce(body);
        }
        if (!sent) log(`[events] dropped after retries: ${body.slice(0, 120)}`);
        queue.shift();
      }
    } finally {
      pumping = false;
      const resolvers = idleResolvers;
      idleResolvers = [];
      for (const r of resolvers) r();
    }
  }

  return {
    emit(type, payload): void {
      if (queue.length >= QUEUE_CAP) {
        queue.shift();
        log(`[events] queue cap hit — dropped oldest event`);
      }
      queue.push(JSON.stringify({ type, payload, seq: seq++ }));
      void pump();
    },
    drain(timeoutMs): Promise<void> {
      if (!pumping && queue.length === 0) return Promise.resolve();
      return new Promise((resolve) => {
        const t = setT(resolve, timeoutMs);
        idleResolvers.push(() => { clearTimeout(t); resolve(); });
      });
    },
  };
}
