import { describe, it, expect } from "vitest";
import { mergeEvents } from "./useWorkerEvents.js";

const ev = (id, ts, type = "jsonl") => ({ id, ts, type });

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
});
