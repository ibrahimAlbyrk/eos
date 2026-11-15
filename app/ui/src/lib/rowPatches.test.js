import { describe, it, expect } from "vitest";
import { keepUnchangedRows, mergeRowChanges } from "./rowPatches.js";

describe("mergeRowChanges", () => {
  const rows = [{ id: "a", state: "IDLE" }, { id: "b", state: "IDLE" }];

  it("replaces in place, appends new rows, drops removed ones", () => {
    const out = mergeRowChanges(rows, [
      { resource: "workers", op: "upsert", data: { id: "b", state: "WORKING" } },
      { resource: "workers", op: "upsert", data: { id: "c", state: "SPAWNING" } },
      { resource: "workers", op: "remove", data: { id: "a" } },
    ], "workers");
    expect(out).toEqual([{ id: "b", state: "WORKING" }, { id: "c", state: "SPAWNING" }]);
  });

  it("ignores another resource's changes and malformed ones", () => {
    const out = mergeRowChanges(rows, [
      { resource: "pending", op: "remove", data: { id: "a" } },
      { resource: "workers", op: "upsert", data: null },
      null,
    ], "workers");
    expect(out).toEqual(rows);
  });

  it("keeps the object of a row that arrives unchanged", () => {
    const list = [{ id: "a", state: "IDLE", context: { pct: 3 } }, { id: "b", state: "IDLE" }];
    const out = mergeRowChanges(list, [
      { resource: "workers", op: "upsert", data: { id: "a", state: "IDLE", context: { pct: 3 } } },
      { resource: "workers", op: "upsert", data: { id: "b", state: "WORKING" } },
    ], "workers");
    expect(out[0]).toBe(list[0]);
    expect(out[1]).toEqual({ id: "b", state: "WORKING" });
  });

  it("returns the same list when nothing in it changed", () => {
    const list = [{ id: "a", state: "IDLE" }];
    const out = mergeRowChanges(list, [{ resource: "workers", op: "upsert", data: { id: "a", state: "IDLE" } }], "workers");
    expect(out).toBe(list);
    expect(mergeRowChanges(list, [{ resource: "pending", op: "upsert", data: { id: "p" } }], "workers")).toBe(list);
  });
});

describe("keepUnchangedRows", () => {
  const a = { id: "a", state: "IDLE", meta: { n: 1 } };
  const b = { id: "b", state: "WORKING" };

  it("an equal list keeps the held array", () => {
    const rows = [a, b];
    expect(keepUnchangedRows(rows, [{ ...a, meta: { n: 1 } }, { ...b }])).toBe(rows);
  });

  it("keeps each equal row's object and takes the changed ones", () => {
    const changed = { ...b, state: "IDLE" };
    const out = keepUnchangedRows([a, b], [{ ...a, meta: { n: 1 } }, changed]);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(changed);
  });

  it("follows the fetched order, additions and removals", () => {
    const c = { id: "c" };
    const out = keepUnchangedRows([a, b], [{ ...b }, c]);
    expect(out).toEqual([b, c]);
    expect(out[0]).toBe(b);
    expect(keepUnchangedRows([a, b], [{ ...b }, { ...a, meta: { n: 1 } }])).toEqual([b, a]);
  });
});
