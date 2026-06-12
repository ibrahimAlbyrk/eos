import { describe, it, expect, vi } from "vitest";
import { mergeEvents, filterOwnRows, windowReducer } from "./useWorkerEvents.js";

const ev = (id, ts, type = "jsonl") => ({ id, ts, type });
const row = (id, workerId, ts = id * 10) => ({ id, worker_id: workerId, ts, type: "jsonl" });

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
    const rows = [row(1, "w-a"), row(2, "w-a")];
    expect(filterOwnRows("w-a", rows)).toEqual(rows);
  });

  it("drops foreign rows and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = [row(1, "w-a"), row(2, "w-b"), row(3, "w-a")];
    expect(filterOwnRows("w-a", rows).map((r) => r.id)).toEqual([1, 3]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("windowReducer", () => {
  const winA = { for: "w-a", events: [row(1, "w-a"), row(2, "w-a")], hasOlder: true };

  it("reset clears the window (null and per-worker forms)", () => {
    expect(windowReducer(winA, { type: "reset" })).toEqual({ for: null, events: [], hasOlder: false });
    expect(windowReducer(winA, { type: "reset", workerId: "w-b" })).toEqual({ for: "w-b", events: [], hasOlder: false });
  });

  it("newest for another worker REPLACES the window — old rows cannot survive a switch", () => {
    const next = windowReducer(winA, { type: "newest", workerId: "w-b", rows: [row(9, "w-b")] });
    expect(next.for).toBe("w-b");
    expect(next.events.map((e) => e.id)).toEqual([9]);
  });

  it("newest for the same worker merges and keeps hasOlder", () => {
    const next = windowReducer(winA, { type: "newest", workerId: "w-a", rows: [row(3, "w-a")] });
    expect(next.events.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(next.hasOlder).toBe(true);
  });

  it("delta and older for a mismatched worker are no-ops (late responses after a switch)", () => {
    expect(windowReducer(winA, { type: "delta", workerId: "w-b", rows: [row(9, "w-b")] })).toBe(winA);
    expect(windowReducer(winA, { type: "older", workerId: "w-b", rows: [row(0, "w-b")] })).toBe(winA);
  });

  it("older for the owner merges and re-decides hasOlder from page fullness", () => {
    const next = windowReducer(winA, { type: "older", workerId: "w-a", rows: [row(0, "w-a")] });
    expect(next.events.map((e) => e.id)).toEqual([0, 1, 2]);
    expect(next.hasOlder).toBe(false);
  });
});
