import { describe, it, expect } from "vitest";
import { archivedRoots } from "./archive.js";

const row = (id, { parent = null, archived = 1000 } = {}) =>
  ({ id, parent_id: parent, archived_at: archived });

describe("archivedRoots", () => {
  it("a top-level archived row is a root", () => {
    const roots = archivedRoots([row("a")]);
    expect(roots.map((w) => w.id)).toEqual(["a"]);
  });

  it("an archived child of an archived parent is not a root", () => {
    const roots = archivedRoots([row("a"), row("b", { parent: "a" })]);
    expect(roots.map((w) => w.id)).toEqual(["a"]);
  });

  it("an archived child of a live (non-archived) parent is a root", () => {
    const roots = archivedRoots([
      row("live", { archived: null }),
      row("b", { parent: "live" }),
    ]);
    expect(roots.map((w) => w.id)).toEqual(["b"]);
  });

  it("an orphaned parent_id (parent purged) counts as a root", () => {
    const roots = archivedRoots([row("b", { parent: "gone" })]);
    expect(roots.map((w) => w.id)).toEqual(["b"]);
  });

  it("non-archived rows never appear", () => {
    const roots = archivedRoots([row("live", { archived: null }), row("a")]);
    expect(roots.map((w) => w.id)).toEqual(["a"]);
  });

  it("roots sort newest-archived first", () => {
    const roots = archivedRoots([
      row("old", { archived: 100 }),
      row("new", { archived: 300 }),
      row("mid", { archived: 200 }),
    ]);
    expect(roots.map((w) => w.id)).toEqual(["new", "mid", "old"]);
  });

  it("deep subtrees collapse to the single archived ancestor root", () => {
    const roots = archivedRoots([
      row("a"),
      row("b", { parent: "a" }),
      row("c", { parent: "b" }),
    ]);
    expect(roots.map((w) => w.id)).toEqual(["a"]);
  });
});
