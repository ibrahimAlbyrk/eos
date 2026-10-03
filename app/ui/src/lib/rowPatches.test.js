import { describe, it, expect } from "vitest";
import { mergeRowChanges } from "./rowPatches.js";

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
});
