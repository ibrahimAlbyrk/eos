import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../api/client.js", () => ({
  api: { getWorkerEvents: vi.fn() },
}));

import { api } from "../api/client.js";
import {
  PAGE_SIZE, OLDER_PAGE_SIZE, OLDER_STEP, OLDER_RETRY_MS, mergeEvents, filterOwnRows,
  attach, fetchDelta, getSnapshot, loadOlder, refetchNewest, subscribe, setFollowing,
  notifyWorkerChanged, refreshAttached,
} from "./eventsStore.js";
import { setStreamLive } from "./streamStatus.js";

const ev = (id, ts, type = "jsonl") => ({ id, ts, type });
const row = (id, workerId, ts = id * 10) => ({ id, worker_id: workerId, ts, type: "jsonl" });
const rows = (workerId, fromId, count) =>
  Array.from({ length: count }, (_, i) => row(fromId + i, workerId));

// Emulates the daemon's /events shapes: newest-N-ASC, beforeId page, afterId delta.
const pageServer = (allRows) => async (workerId, { limit, beforeId, afterId } = {}) => {
  const own = allRows.filter((r) => r.worker_id === workerId);
  if (afterId != null) return own.filter((r) => r.id > afterId).slice(0, limit);
  const pool = beforeId != null ? own.filter((r) => r.id < beforeId) : own;
  return pool.slice(-limit);
};

let nextId = 0;
const freshId = () => `w${nextId++}`;
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mergeEvents", () => {
  it("returns incoming when current is empty", () => {
    const incoming = [ev(1, 10), ev(2, 20)];
    expect(mergeEvents([], incoming)).toEqual(incoming);
  });

  it("returns current when incoming is empty", () => {
    const current = [ev(1, 10)];
    expect(mergeEvents(current, [])).toBe(current);
  });

  it("prepends an older page before the loaded window", () => {
    const current = [ev(5, 50), ev(6, 60)];
    const older = [ev(3, 30), ev(4, 40)];
    expect(mergeEvents(current, older).map((e) => e.id)).toEqual([3, 4, 5, 6]);
  });

  it("keeps loaded history when a newest-page refetch overlaps", () => {
    const current = [ev(1, 10), ev(2, 20), ev(3, 30)];
    const newest = [ev(2, 20), ev(3, 30), ev(4, 40)];
    expect(mergeEvents(current, newest).map((e) => e.id)).toEqual([1, 2, 3, 4]);
  });

  it("incoming row wins on id collision (server-side payload patch)", () => {
    const current = [{ id: 1, ts: 10, type: "usage", payload: "old" }];
    const incoming = [{ id: 1, ts: 10, type: "usage", payload: "patched" }];
    expect(mergeEvents(current, incoming)[0].payload).toBe("patched");
  });

  it("orders same-ts rows by id (insertion order)", () => {
    const current = [ev(2, 10)];
    const incoming = [ev(1, 10), ev(3, 10)];
    expect(mergeEvents(current, incoming).map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it("appends a delta page (afterId fetch) after the loaded window", () => {
    const current = [ev(1, 10), ev(2, 20)];
    const delta = [ev(3, 30), ev(4, 40)];
    expect(mergeEvents(current, delta).map((e) => e.id)).toEqual([1, 2, 3, 4]);
  });
});

describe("filterOwnRows", () => {
  it("passes rows belonging to the requested worker through unchanged", () => {
    const own = [row(1, "w-a"), row(2, "w-a")];
    expect(filterOwnRows("w-a", own)).toEqual(own);
  });

  it("drops foreign rows and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mixed = [row(1, "w-a"), row(2, "w-b"), row(3, "w-a")];
    expect(filterOwnRows("w-a", mixed).map((r) => r.id)).toEqual([1, 3]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("eventsStore", () => {
  it("attach loads the newest page; hasOlder follows page fullness", async () => {
    const id = freshId();
    api.getWorkerEvents.mockImplementation(pageServer(rows(id, 1, 3)));
    const detach = attach(id);
    await tick();
    const snap = getSnapshot(id);
    expect(snap.eventsFor).toBe(id);
    expect(snap.events.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(snap.hasOlder).toBe(false); // partial page → no older rows
    detach();
  });

  it("a full first page opens the older cursor", async () => {
    const id = freshId();
    api.getWorkerEvents.mockImplementation(pageServer(rows(id, 1, PAGE_SIZE + 10)));
    const detach = attach(id);
    await tick();
    expect(getSnapshot(id).hasOlder).toBe(true);
    expect(getSnapshot(id).events).toHaveLength(PAGE_SIZE);
    detach();
  });

  it("loadOlder without a parked prefetch fetches, toggles loadingOlder, merges", async () => {
    const id = freshId();
    api.getWorkerEvents.mockImplementation(pageServer(rows(id, 1, PAGE_SIZE + 50)));
    const detach = attach(id);
    await tick();
    loadOlder(id); // before the idle prefetch fires → network path
    expect(getSnapshot(id).loadingOlder).toBe(true);
    loadOlder(id); // single-flight: second call is a no-op
    await tick();
    const snap = getSnapshot(id);
    expect(snap.loadingOlder).toBe(false);
    expect(snap.events).toHaveLength(PAGE_SIZE + 50);
    expect(snap.hasOlder).toBe(false);
    detach();
  });

  it("parks one older page while the reader stays at the tail, and shows none of it", async () => {
    const id = freshId();
    api.getWorkerEvents.mockImplementation(pageServer(rows(id, 1, PAGE_SIZE + 3 * OLDER_PAGE_SIZE)));
    const detach = attach(id);
    await tick();
    await tick(2000);
    expect(api.getWorkerEvents).toHaveBeenCalledTimes(2);
    expect(api.getWorkerEvents).toHaveBeenLastCalledWith(
      id, expect.objectContaining({ order: "desc", limit: OLDER_PAGE_SIZE, beforeId: 3 * OLDER_PAGE_SIZE + 1 }),
    );
    expect(getSnapshot(id).events).toHaveLength(PAGE_SIZE);
    detach();
  });

  it("loadOlder moves parked rows into the window at once, a step at a time", async () => {
    const id = freshId();
    api.getWorkerEvents.mockImplementation(pageServer(rows(id, 1, PAGE_SIZE + 2 * OLDER_PAGE_SIZE)));
    const detach = attach(id);
    await tick();
    await tick(250); // idle gap → the next older page is parked
    const callsBefore = api.getWorkerEvents.mock.calls.length;
    loadOlder(id);
    // No await: the parked rows must land synchronously, with no loading state.
    const snap = getSnapshot(id);
    expect(snap.events).toHaveLength(PAGE_SIZE + OLDER_STEP);
    expect(snap.events[0].id).toBe(2 * OLDER_PAGE_SIZE - OLDER_STEP + 1); // the rows next to the window
    expect(snap.hasOlder).toBe(true);
    expect(snap.loadingOlder).toBe(false);
    expect(api.getWorkerEvents.mock.calls.length).toBe(callsBefore);
    loadOlder(id);
    expect(getSnapshot(id).events).toHaveLength(PAGE_SIZE + OLDER_PAGE_SIZE);
    await tick(250); // nothing left parked → the next page is read ahead
    expect(api.getWorkerEvents.mock.calls.length).toBe(callsBefore + 1);
    detach();
  });

  it("a reader in history gets the whole chat without asking for it", async () => {
    const id = freshId();
    const total = PAGE_SIZE + 2 * OLDER_PAGE_SIZE + 70;
    api.getWorkerEvents.mockImplementation(pageServer(rows(id, 1, total)));
    const detach = attach(id);
    await tick();
    setFollowing(id, false); // the reader scrolled up from the tail
    await tick(250);
    const snap = getSnapshot(id);
    expect(snap.events).toHaveLength(total);
    expect(snap.events[0].id).toBe(1);
    expect(snap.hasOlder).toBe(false);
    expect(snap.loadingOlder).toBe(false);
    detach();
  });

  it("rows the live window trims are parked: paging them back in asks for nothing", async () => {
    const id = freshId();
    const all = rows(id, 1, PAGE_SIZE);
    api.getWorkerEvents.mockImplementation(pageServer(all));
    const detach = attach(id); // following
    await tick();
    let nextRowId = PAGE_SIZE + 1;
    for (let i = 0; i < 5; i++) {
      for (let k = 0; k < PAGE_SIZE; k++) all.push(row(nextRowId++, id));
      fetchDelta(id);
      await tick();
    }
    expect(getSnapshot(id).events).toHaveLength(4 * PAGE_SIZE);
    expect(getSnapshot(id).hasOlder).toBe(true);
    const callsBefore = api.getWorkerEvents.mock.calls.length;
    loadOlder(id);
    expect(getSnapshot(id).events).toHaveLength(4 * PAGE_SIZE + OLDER_STEP);
    expect(api.getWorkerEvents.mock.calls.length).toBe(callsBefore);
    // The view paged up to this size, so the stream no longer trims below it.
    for (let k = 0; k < PAGE_SIZE; k++) all.push(row(nextRowId++, id));
    fetchDelta(id);
    await tick();
    expect(getSnapshot(id).events).toHaveLength(4 * PAGE_SIZE + OLDER_STEP);
    detach();
  });

  it("fetchDelta pulls afterId rows, merges, and notifies onNewest", async () => {
    const id = freshId();
    const all = rows(id, 1, 3);
    api.getWorkerEvents.mockImplementation(pageServer(all));
    const onNewest = vi.fn();
    const detach = attach(id, { onNewest });
    await tick();
    onNewest.mockClear();
    all.push(row(4, id), row(5, id));
    fetchDelta(id);
    await tick();
    expect(getSnapshot(id).events.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
    expect(onNewest).toHaveBeenCalledWith(id, [row(4, id), row(5, id)]);
    detach();
  });

  it("the recurring 5s poll fetches afterId, not a full newest page, after first load", async () => {
    const id = freshId();
    const all = rows(id, 1, 3);
    api.getWorkerEvents.mockImplementation(pageServer(all));
    const detach = attach(id);
    await tick(); // initial attach → full newest page (order desc, no afterId)
    expect(api.getWorkerEvents).toHaveBeenLastCalledWith(
      id, expect.objectContaining({ order: "desc", limit: PAGE_SIZE }),
    );
    api.getWorkerEvents.mockClear();
    all.push(row(4, id));
    await tick(5000); // recurring poll fires once
    expect(api.getWorkerEvents).toHaveBeenCalledTimes(1);
    const [, opts] = api.getWorkerEvents.mock.calls[0];
    expect(opts.afterId).toBe(3); // incremental: only rows past the loaded tail
    expect(opts.order).toBeUndefined(); // not a newest-page refetch
    expect(getSnapshot(id).events.map((e) => e.id)).toEqual([1, 2, 3, 4]);
    detach();
  });

  it("the recurring afterId poll keeps the window on a non-array body (stale beats empty)", async () => {
    const id = freshId();
    api.getWorkerEvents.mockImplementation(pageServer(rows(id, 1, 3)));
    const detach = attach(id);
    await tick();
    api.getWorkerEvents.mockResolvedValue({ error: "nope" });
    await tick(5000); // afterId poll fires; a non-array delta is a no-op, not a blank
    expect(getSnapshot(id).events).toHaveLength(3);
    expect(getSnapshot(id).eventsFor).toBe(id);
    detach();
  });

  it("a network blip keeps the cached window (stale beats empty)", async () => {
    const id = freshId();
    api.getWorkerEvents.mockImplementation(pageServer(rows(id, 1, 3)));
    const detach = attach(id);
    await tick();
    api.getWorkerEvents.mockRejectedValue(new Error("boom"));
    await tick(5000); // poll fires and fails
    expect(getSnapshot(id).events).toHaveLength(3);
    expect(getSnapshot(id).eventsFor).toBe(id);
    detach();
  });

  it("a non-array newest body blanks a loaded window (leak guard, full-page path)", async () => {
    const id = freshId();
    api.getWorkerEvents.mockImplementation(pageServer(rows(id, 1, 3)));
    const detach = attach(id);
    await tick();
    api.getWorkerEvents.mockResolvedValue({ error: "nope" });
    refetchNewest(id); // restart/attach full-page refetch — where the leak guard lives
    await tick();
    expect(getSnapshot(id).events).toHaveLength(0);
    expect(getSnapshot(id).eventsFor).toBeNull();
    detach();
  });

  it("foreign rows in a response are dropped, never rendered", async () => {
    const id = freshId();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    api.getWorkerEvents.mockResolvedValue([row(1, id), row(2, "w-other")]);
    const detach = attach(id);
    await tick();
    expect(getSnapshot(id).events.map((e) => e.id)).toEqual([1]);
    warn.mockRestore();
    detach();
  });

  it("the window survives detach: switch-back renders from cache", async () => {
    const id = freshId();
    api.getWorkerEvents.mockImplementation(pageServer(rows(id, 1, 3)));
    const detach = attach(id);
    await tick();
    detach();
    expect(getSnapshot(id).events).toHaveLength(3);
    expect(getSnapshot(id).eventsFor).toBe(id);
  });

  it("detach trims an over-long window to its newest rows and re-opens hasOlder", async () => {
    const id = freshId();
    api.getWorkerEvents.mockImplementation(pageServer(rows(id, 1, 4 * PAGE_SIZE)));
    const detach = attach(id);
    await tick();
    loadOlder(id);
    await tick();
    loadOlder(id);
    await tick();
    loadOlder(id);
    await tick();
    expect(getSnapshot(id).events).toHaveLength(4 * PAGE_SIZE);
    detach();
    const snap = getSnapshot(id);
    expect(snap.events).toHaveLength(3 * PAGE_SIZE);
    expect(snap.events[0].id).toBe(PAGE_SIZE + 1); // newest rows kept
    expect(snap.hasOlder).toBe(true);
  });

  it("evicts the least-recently-attached detached windows beyond the cap", async () => {
    const ids = Array.from({ length: 7 }, freshId);
    for (const id of ids) {
      api.getWorkerEvents.mockImplementation(pageServer(rows(id, 1, 2)));
      const detach = attach(id);
      await tick();
      detach();
    }
    expect(getSnapshot(ids[0]).eventsFor).toBeNull(); // evicted
    expect(getSnapshot(ids[6]).eventsFor).toBe(ids[6]); // recent ones cached
  });

  it("an attached, following window is capped to MAX_ATTACHED_EVENTS as the tail streams", async () => {
    const id = freshId();
    const all = rows(id, 1, PAGE_SIZE); // full first page → hasOlder
    api.getWorkerEvents.mockImplementation(pageServer(all));
    const detach = attach(id); // following defaults true
    await tick();
    expect(getSnapshot(id).events).toHaveLength(PAGE_SIZE);
    // Stream well past the attached cap in PAGE_SIZE deltas.
    let nextRowId = PAGE_SIZE + 1;
    for (let i = 0; i < 6; i++) {
      for (let k = 0; k < PAGE_SIZE; k++) all.push(row(nextRowId++, id));
      fetchDelta(id);
      await tick();
    }
    const snap = getSnapshot(id);
    expect(snap.events).toHaveLength(4 * PAGE_SIZE); // MAX_ATTACHED_EVENTS
    expect(snap.hasOlder).toBe(true); // trimming re-opens the older cursor
    expect(snap.events[snap.events.length - 1].id).toBe(nextRowId - 1); // newest kept
    detach();
  });

  it("a failed older page keeps loading until the retry delay, then can be asked again", async () => {
    const id = freshId();
    const serve = pageServer(rows(id, 1, PAGE_SIZE + 50));
    let fail = true;
    api.getWorkerEvents.mockImplementation(async (workerId, opts = {}) => {
      if (opts.beforeId != null && fail) throw new Error("blip");
      return serve(workerId, opts);
    });
    const detach = attach(id);
    await tick();
    loadOlder(id);
    await tick();
    expect(getSnapshot(id).loadingOlder).toBe(true); // held back, not spinning
    fail = false;
    await tick(OLDER_RETRY_MS);
    const failed = getSnapshot(id);
    expect(failed.loadingOlder).toBe(false);
    expect(failed.hasOlder).toBe(true);
    loadOlder(id);
    await tick();
    expect(getSnapshot(id).events).toHaveLength(PAGE_SIZE + 50);
    detach();
  });

  it("a scrolled-up (not following) window keeps every row while the tail streams", async () => {
    const id = freshId();
    const all = rows(id, 1, PAGE_SIZE);
    api.getWorkerEvents.mockImplementation(pageServer(all));
    const detach = attach(id);
    await tick();
    setFollowing(id, false); // user scrolled up to read history
    let nextRowId = PAGE_SIZE + 1;
    for (let i = 0; i < 14; i++) {
      for (let k = 0; k < PAGE_SIZE; k++) all.push(row(nextRowId++, id));
      fetchDelta(id);
      await tick();
    }
    // Far above MAX_ATTACHED (2000): a trim would drop the oldest rows, the
    // ones the reader is on.
    expect(getSnapshot(id).events).toHaveLength(15 * PAGE_SIZE);
    expect(getSnapshot(id).events[0].id).toBe(1);
    // Back at the tail the window is capped again.
    setFollowing(id, true);
    expect(getSnapshot(id).events).toHaveLength(4 * PAGE_SIZE);
    detach();
  });

  it("notifies subscribers on window changes and stops after unsubscribe", async () => {
    const id = freshId();
    api.getWorkerEvents.mockImplementation(pageServer(rows(id, 1, 2)));
    const cb = vi.fn();
    const unsub = subscribe(id, cb);
    const detach = attach(id);
    await tick();
    expect(cb).toHaveBeenCalled();
    cb.mockClear();
    unsub();
    detach();
    fetchDelta(id);
    await tick();
    expect(cb).not.toHaveBeenCalled();
  });

  describe("live updates with the stream up", () => {
    afterEach(() => setStreamLive(false));

    it("switching back to a cached window pulls only its tail", async () => {
      const id = freshId();
      const all = rows(id, 1, 3);
      api.getWorkerEvents.mockImplementation(pageServer(all));
      attach(id)();
      await tick();
      all.push(row(4, id));
      api.getWorkerEvents.mockClear();
      const detach = attach(id);
      await tick();
      expect(api.getWorkerEvents.mock.calls.map(([, o]) => o.afterId)).toEqual([3]);
      expect(getSnapshot(id).events.map((e) => e.id)).toEqual([1, 2, 3, 4]);
      detach();
    });

    it("a change event pulls the tail; the poll stays quiet while the stream is live", async () => {
      const id = freshId();
      const all = rows(id, 1, 2);
      api.getWorkerEvents.mockImplementation(pageServer(all));
      setStreamLive(true);
      const detach = attach(id);
      await tick();
      api.getWorkerEvents.mockClear();
      await tick(12_000);
      expect(api.getWorkerEvents).not.toHaveBeenCalled();
      all.push(row(3, id));
      notifyWorkerChanged(id);
      notifyWorkerChanged(id); // same burst
      await tick(60);
      expect(api.getWorkerEvents).toHaveBeenCalledTimes(1);
      expect(getSnapshot(id).events.map((e) => e.id)).toEqual([1, 2, 3]);
      detach();
    });

    it("a change during a tail fetch asks for one more (the first may predate the row)", async () => {
      const id = freshId();
      const all = rows(id, 1, 1);
      let release;
      api.getWorkerEvents.mockImplementation(pageServer(all));
      const detach = attach(id);
      await tick();
      api.getWorkerEvents.mockImplementation((w, o) => new Promise((r) => { release = () => r(pageServer(all)(w, o)); }));
      fetchDelta(id);
      all.push(row(2, id));
      fetchDelta(id); // lands while the first is in flight
      release();
      await tick();
      release();
      await tick();
      expect(getSnapshot(id).events.map((e) => e.id)).toEqual([1, 2]);
      detach();
    });

    it("refreshAttached pulls every shown transcript's tail", async () => {
      const a = freshId();
      const b = freshId();
      api.getWorkerEvents.mockImplementation(pageServer([...rows(a, 1, 1), ...rows(b, 10, 1)]));
      const da = attach(a);
      const db = attach(b);
      await tick();
      api.getWorkerEvents.mockClear();
      refreshAttached();
      await tick();
      expect(api.getWorkerEvents.mock.calls.map(([w]) => w).sort()).toEqual([a, b].sort());
      da(); db();
    });
  });
});
