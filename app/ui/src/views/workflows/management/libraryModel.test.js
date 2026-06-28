import { describe, it, expect } from "vitest";
import {
  isGraphDefinition, provenanceOf, isReadOnly, isDeletable, canEdit, canDuplicate, canOpen,
  latestRunFor, duplicateName, duplicateDoc, recordToDoc,
} from "./libraryModel.js";

const graph = (name, source) => ({ name, version: 2, source, nodes: [], edges: [] });
const tree = (name, source) => ({ name, source, root: { type: "sequence", children: [] } });

describe("libraryModel — kind", () => {
  it("isGraphDefinition is true only for version 2", () => {
    expect(isGraphDefinition(graph("g", "runtime"))).toBe(true);
    expect(isGraphDefinition(tree("t", "builtin"))).toBe(false);
    expect(isGraphDefinition(undefined)).toBe(false);
  });
});

describe("libraryModel — provenance → read-only/deletable rule", () => {
  it("provenanceOf reads source, defaulting to runtime", () => {
    expect(provenanceOf(graph("g", "builtin"))).toBe("builtin");
    expect(provenanceOf({ name: "x" })).toBe("runtime");
  });

  it("only runtime defs are editable + deletable; everything else is read-only", () => {
    for (const source of ["builtin", "user", "project"]) {
      const r = graph("g", source);
      expect(isReadOnly(r)).toBe(true);
      expect(isDeletable(r)).toBe(false);
    }
    const rt = graph("g", "runtime");
    expect(isReadOnly(rt)).toBe(false);
    expect(isDeletable(rt)).toBe(true);
  });

  it("Edit needs a runtime graph; Duplicate needs any graph", () => {
    expect(canEdit(graph("g", "runtime"))).toBe(true);
    expect(canEdit(graph("g", "user"))).toBe(false); // read-only graph → Duplicate only
    expect(canEdit(tree("t", "runtime"))).toBe(false); // tree → not editor-loadable

    expect(canDuplicate(graph("g", "builtin"))).toBe(true);
    expect(canDuplicate(graph("g", "runtime"))).toBe(true);
    expect(canDuplicate(tree("t", "builtin"))).toBe(false);
  });

  it("card is openable for any graph (runtime or read-only), never a tree", () => {
    expect(canOpen(graph("g", "runtime"))).toBe(true); // → editable
    expect(canOpen(graph("g", "builtin"))).toBe(true); // → read-only view
    expect(canOpen(tree("t", "builtin"))).toBe(false); // v1 tree: no render path
    expect(canOpen(tree("t", "runtime"))).toBe(false);
  });
});

describe("libraryModel — latest-run matching", () => {
  const runs = [
    { id: "r1", definitionName: "alpha", status: "passed", updatedAt: 100 },
    { id: "r2", definitionName: "alpha", status: "running", updatedAt: 300 },
    { id: "r3", definitionName: "beta", status: "failed", updatedAt: 200 },
    { id: "r4", definitionName: null, status: "passed", updatedAt: 999 },
  ];

  it("picks the most-recently-updated run for the matching definition", () => {
    expect(latestRunFor("alpha", runs).id).toBe("r2");
    expect(latestRunFor("beta", runs).id).toBe("r3");
  });

  it("returns null when a definition has no runs (and ignores inline/null-name runs)", () => {
    expect(latestRunFor("gamma", runs)).toBe(null);
    expect(latestRunFor(null, runs)).toBe(null);
    expect(latestRunFor("alpha", [])).toBe(null);
  });

  it("falls back to startedAt when updatedAt is absent", () => {
    const r = latestRunFor("x", [
      { id: "a", definitionName: "x", startedAt: 5 },
      { id: "b", definitionName: "x", startedAt: 9 },
    ]);
    expect(r.id).toBe("b");
  });
});

describe("libraryModel — duplicate name/doc", () => {
  it("appends -copy, then -copy-2, -copy-3 on collision", () => {
    expect(duplicateName("flow", [])).toBe("flow-copy");
    expect(duplicateName("flow", ["flow-copy"])).toBe("flow-copy-2");
    expect(duplicateName("flow", ["flow-copy", "flow-copy-2"])).toBe("flow-copy-3");
  });

  it("recordToDoc strips the provenance tag", () => {
    const doc = recordToDoc(graph("g", "builtin"));
    expect(doc.source).toBeUndefined();
    expect(doc).toEqual({ name: "g", version: 2, nodes: [], edges: [] });
  });

  it("duplicateDoc clones the graph with a fresh unique name", () => {
    const doc = duplicateDoc(graph("flow", "builtin"), ["flow", "flow-copy"]);
    expect(doc.name).toBe("flow-copy-2");
    expect(doc.source).toBeUndefined();
    expect(doc.version).toBe(2);
  });
});
