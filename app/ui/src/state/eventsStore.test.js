import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../api/client.js", () => ({
  api: { getWorkerEvents: vi.fn() },
}));

import { api } from "../api/client.js";
import {
  PAGE_SIZE, mergeEvents, filterOwnRows,
  attach, fetchDelta, getSnapshot, loadOlder, refetchNewest, subscribe, setFollowing,
} from "./eventsStore.js";

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

  it("read-ahead prefetch makes the next loadOlder a synchronous prepend", async () => {
    const id = freshId();
    api.getWorkerEvents.mockImplementation(pageServer(rows(id, 1, 3 * PAGE_SIZE)));
    const detach = attach(id);
    await tick();
    await tick(250); // idle gap → prefetch fetches the next older page
    const callsBefore = api.getWorkerEvents.mock.calls.length;
    loadOlder(id);
    // No await: the parked page must land synchronously, with no loading state.
    const snap = getSnapshot(id);
    expect(snap.events).toHaveLength(2 * PAGE_SIZE);
    expect(snap.loadingOlder).toBe(false);
    expect(api.getWorkerEvents.mock.calls.length).toBe(callsBefore);
    await tick(250); // the consume re-arms the next prefetch
    expect(api.getWorkerEvents.mock.calls.length).toBeGreaterThan(callsBefore);
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

  it("a scrolled-up (not following) window is bounded only by the looser HARD_MAX", async () => {
    const id = freshId();
    const all = rows(id, 1, PAGE_SIZE);
    api.getWorkerEvents.mockImplementation(pageServer(all));
    const detach = attach(id);
    await tick();
    setFollowing(id, false); // user scrolled up to read history
    let nextRowId = PAGE_SIZE + 1;
    for (let i = 0; i < 6; i++) {
      for (let k = 0; k < PAGE_SIZE; k++) all.push(row(nextRowId++, id));
      fetchDelta(id);
      await tick();
    }
    // 7*PAGE_SIZE (3500) is above MAX_ATTACHED (2000) but below HARD_MAX (6000)
    // → kept untrimmed so loadOlder's prepends aren't immediately undone.
    expect(getSnapshot(id).events).toHaveLength(7 * PAGE_SIZE);
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
});
