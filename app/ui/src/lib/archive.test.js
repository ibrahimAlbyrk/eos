import { describe, it, expect } from "vitest";
import { archivedTree } from "./archive.js";

const row = (id, { parent = null, archived = 1000, started = 0 } = {}) =>
  ({ id, parent_id: parent, archived_at: archived, started_at: started });

describe("archivedTree", () => {
  it("a top-level archived row is a root", () => {
    const roots = archivedTree([row("a")]);
    expect(roots.map((w) => w.id)).toEqual(["a"]);
  });

  it("an archived child of an archived parent nests under it, not as a root", () => {
    const roots = archivedTree([row("a"), row("b", { parent: "a" })]);
    expect(roots.map((w) => w.id)).toEqual(["a"]);
    expect(roots[0].children.map((w) => w.id)).toEqual(["b"]);
  });

  it("an archived child of a live (non-archived) parent is a root", () => {
    const roots = archivedTree([
      row("live", { archived: null }),
      row("b", { parent: "live" }),
    ]);
    expect(roots.map((w) => w.id)).toEqual(["b"]);
  });

  it("an orphaned parent_id (parent purged) counts as a root", () => {
    const roots = archivedTree([row("b", { parent: "gone" })]);
    expect(roots.map((w) => w.id)).toEqual(["b"]);
  });

  it("non-archived rows never appear", () => {
    const roots = archivedTree([row("live", { archived: null }), row("a")]);
    expect(roots.map((w) => w.id)).toEqual(["a"]);
  });

  it("roots sort newest-archived first", () => {
    const roots = archivedTree([
      row("old", { archived: 100 }),
      row("new", { archived: 300 }),
      row("mid", { archived: 200 }),
    ]);
    expect(roots.map((w) => w.id)).toEqual(["new", "mid", "old"]);
  });

  it("deep subtrees nest under the single archived ancestor root", () => {
    const roots = archivedTree([
      row("a"),
      row("b", { parent: "a" }),
      row("c", { parent: "b" }),
    ]);
    expect(roots.map((w) => w.id)).toEqual(["a"]);
    expect(roots[0].children.map((w) => w.id)).toEqual(["b"]);
    expect(roots[0].children[0].children.map((w) => w.id)).toEqual(["c"]);
  });

  it("children sort started_at ASC like the live tree", () => {
    const roots = archivedTree([
      row("a"),
      row("late", { parent: "a", started: 300 }),
      row("early", { parent: "a", started: 100 }),
    ]);
    expect(roots[0].children.map((w) => w.id)).toEqual(["early", "late"]);
  });

  it("every node carries a children array (leaves get an empty one)", () => {
    const roots = archivedTree([row("a"), row("b", { parent: "a" })]);
    expect(roots[0].children[0].children).toEqual([]);
  });
});
