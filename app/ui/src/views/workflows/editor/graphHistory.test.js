import { describe, it, expect } from "vitest";
// Undo/redo for the editor is the shared lib undoStack with graphModel STATES as
// the opaque snapshots (the persisted doc — not RF's ephemeral viewport/selection).
// This proves the round-trip the editor relies on: each committed mutation pushes a
// snapshot, Cmd+Z restores the prior doc exactly, Cmd+Shift+Z replays it.
import { initUndo, recordDiscrete, undo, redo, canUndo, canRedo, bound } from "../../../lib/undoStack.js";
import { createInitialGraph, addNode, addEdge } from "./graphModel.js";

const workerEntry = { kind: "worker", label: "Worker", category: "compute", inputs: [{ name: "in", type: "any" }], outputs: [{ name: "out", type: "any" }] };

// Drive the same push-on-commit policy the editor uses, returning the history.
function commit(history, graph) {
  return bound(recordDiscrete(history, graph));
}

describe("graphHistory — undoStack over graphModel snapshots", () => {
  it("undo restores the exact prior doc and redo replays it", () => {
    const g0 = createInitialGraph({ name: "demo" });
    let h = initUndo(g0);

    const a = addNode(g0, workerEntry);
    const g1 = a.state;
    h = commit(h, g1);

    const g2 = addEdge(g1, { node: "input", port: "out" }, { node: a.node.id, port: "in" }).state;
    h = commit(h, g2);

    expect(g2.nodes.length).toBe(3);
    expect(g2.edges.length).toBe(1);

    // Undo the edge: back to g1 (node added, no edge).
    let r = undo(h); h = r.state;
    expect(r.snapshot).toBe(g1);
    expect(r.snapshot.edges.length).toBe(0);
    expect(r.snapshot.nodes.length).toBe(3);

    // Undo the add: back to g0 (just input/output).
    r = undo(h); h = r.state;
    expect(r.snapshot).toBe(g0);
    expect(r.snapshot.nodes.length).toBe(2);
    expect(canUndo(h)).toBe(false);

    // Redo replays g1 then g2 in order.
    r = redo(h); h = r.state;
    expect(r.snapshot).toBe(g1);
    r = redo(h); h = r.state;
    expect(r.snapshot).toBe(g2);
    expect(canRedo(h)).toBe(false);
  });

  it("a fresh edit after undo abandons the redo branch", () => {
    const g0 = createInitialGraph();
    let h = initUndo(g0);
    const g1 = addNode(g0, workerEntry).state;
    h = commit(h, g1);
    const g2 = addNode(g1, workerEntry).state;
    h = commit(h, g2);

    h = undo(h).state; // now at g1, g2 on the redo branch
    expect(canRedo(h)).toBe(true);

    const g1b = addNode(g1, workerEntry).state; // a fresh edit branching off g1
    h = commit(h, g1b);
    expect(canRedo(h)).toBe(false); // redo branch (g2) discarded
    expect(undo(h).snapshot).toBe(g1);
  });
});
