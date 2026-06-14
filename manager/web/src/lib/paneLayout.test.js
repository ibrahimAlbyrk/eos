import { describe, it, expect } from "vitest";
import {
  leaf, isLeaf, isValidTree, leaves, leafCount, findLeaf, leafOfAgent,
  setLeafAgent, splitLeaf, removeLeaf, setRatio, replaceDeadAgents,
  computeRects, computeDividers, dropZoneFromPoint, fanoutLayout,
  stripAgents, fillAgents, MAX_PANES,
} from "./paneLayout.js";

describe("leaf / leaves / count", () => {
  it("a lone leaf is one pane", () => {
    const t = leaf("a");
    expect(isLeaf(t)).toBe(true);
    expect(leaves(t).map((l) => l.agentId)).toEqual(["a"]);
    expect(leafCount(t)).toBe(1);
  });
  it("DFS order is a before b", () => {
    const root = leaf("a");
    const s1 = splitLeaf(root, root.id, "row", "after", "b").tree; // [a, b]
    const s2 = splitLeaf(s1, leaves(s1)[0].id, "col", "after", "c").tree; // [a, c, b]
    expect(leaves(s2).map((l) => l.agentId)).toEqual(["a", "c", "b"]);
  });
});

describe("splitLeaf", () => {
  it("splits a leaf into [existing, fresh] honoring side", () => {
    const root = leaf("a");
    const { tree, newId } = splitLeaf(root, root.id, "row", "after", "b");
    expect(tree.t).toBe("split");
    expect(tree.dir).toBe("row");
    expect(tree.ratio).toBe(0.5);
    expect(leaves(tree).map((l) => l.agentId)).toEqual(["a", "b"]);
    expect(findLeaf(tree, newId).agentId).toBe("b");
  });
  it("side 'before' puts the new leaf first", () => {
    const root = leaf("a");
    const { tree } = splitLeaf(root, root.id, "col", "before", "b");
    expect(leaves(tree).map((l) => l.agentId)).toEqual(["b", "a"]);
  });
  it("is a no-op at the cap", () => {
    // build a tree of MAX_PANES leaves by repeatedly splitting the first leaf
    let tree = leaf("0");
    for (let i = 1; i < MAX_PANES; i++) tree = splitLeaf(tree, leaves(tree)[0].id, "row", "after", String(i)).tree;
    expect(leafCount(tree)).toBe(MAX_PANES);
    const r = splitLeaf(tree, leaves(tree)[0].id, "row", "after", "x");
    expect(r.tree).toBe(tree);
    expect(r.newId).toBe(null);
  });
  it("is a no-op for an unknown leaf", () => {
    const root = leaf("a");
    expect(splitLeaf(root, "nope", "row", "after", "b").tree).toBe(root);
  });
});

describe("removeLeaf", () => {
  it("collapses the parent split to the sibling", () => {
    const root = leaf("a");
    const { tree, newId } = splitLeaf(root, root.id, "row", "after", "b");
    const next = removeLeaf(tree, newId);
    expect(isLeaf(next)).toBe(true);
    expect(next.agentId).toBe("a");
  });
  it("never removes the only leaf", () => {
    const root = leaf("a");
    expect(removeLeaf(root, root.id)).toBe(root);
  });
});

describe("setRatio / setLeafAgent", () => {
  it("updates and clamps a split's ratio", () => {
    const root = leaf("a");
    const { tree } = splitLeaf(root, root.id, "row", "after", "b");
    expect(setRatio(tree, tree.id, 0.7).ratio).toBe(0.7);
    expect(setRatio(tree, tree.id, 0.99).ratio).toBe(0.85);
    expect(setRatio(tree, tree.id, 0.01).ratio).toBe(0.15);
  });
  it("sets a leaf's agent", () => {
    const root = leaf("a");
    expect(setLeafAgent(root, root.id, "z").agentId).toBe("z");
  });
});

describe("replaceDeadAgents", () => {
  it("nulls dead agents but keeps the protected one", () => {
    const root = leaf("a");
    const { tree } = splitLeaf(root, root.id, "row", "after", "b");
    const alive = (id) => id === "a"; // b is dead
    const next = replaceDeadAgents(tree, alive, null);
    expect(leaves(next).map((l) => l.agentId)).toEqual(["a", null]);
    // protected dead agent is kept
    const kept = replaceDeadAgents(tree, () => false, "a");
    expect(leafOfAgent(kept, "a")).toBeTruthy();
  });
});

describe("computeRects", () => {
  it("a lone leaf fills 100%", () => {
    const [r] = computeRects(leaf("a"));
    expect(r.rect).toEqual({ left: 0, top: 0, width: 100, height: 100 });
  });
  it("a row split divides width by ratio", () => {
    const root = leaf("a");
    const { tree } = splitLeaf(root, root.id, "row", "after", "b"); // ratio 0.5
    const rects = computeRects(tree);
    expect(rects[0].rect).toMatchObject({ left: 0, width: 50, height: 100 });
    expect(rects[1].rect).toMatchObject({ left: 50, width: 50 });
  });
  it("a col split divides height", () => {
    const root = leaf("a");
    let { tree } = splitLeaf(root, root.id, "col", "after", "b");
    tree = setRatio(tree, tree.id, 0.25);
    const rects = computeRects(tree);
    expect(rects[0].rect).toMatchObject({ top: 0, height: 25 });
    expect(rects[1].rect).toMatchObject({ top: 25, height: 75 });
  });
});

describe("computeDividers", () => {
  it("one divider per split, at the boundary", () => {
    const root = leaf("a");
    const { tree } = splitLeaf(root, root.id, "row", "after", "b");
    const ds = computeDividers(tree);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ id: tree.id, dir: "row", pos: 50 });
  });
});

describe("dropZoneFromPoint", () => {
  it("center → replace", () => {
    expect(dropZoneFromPoint(0.5, 0.5)).toEqual({ kind: "replace" });
  });
  it("edges → split with the right dir/side", () => {
    expect(dropZoneFromPoint(0.1, 0.5)).toMatchObject({ kind: "split", dir: "row", side: "before", edge: "left" });
    expect(dropZoneFromPoint(0.9, 0.5)).toMatchObject({ kind: "split", dir: "row", side: "after", edge: "right" });
    expect(dropZoneFromPoint(0.5, 0.1)).toMatchObject({ kind: "split", dir: "col", side: "before", edge: "top" });
    expect(dropZoneFromPoint(0.5, 0.9)).toMatchObject({ kind: "split", dir: "col", side: "after", edge: "bottom" });
  });
  it("just inside the center band stays replace", () => {
    expect(dropZoneFromPoint(0.35, 0.5)).toEqual({ kind: "replace" });
  });
});

describe("fanoutLayout", () => {
  it("no children → a lone orchestrator leaf", () => {
    expect(isLeaf(fanoutLayout("O", []))).toBe(true);
  });
  it("orchestrator left, children right, in order", () => {
    const t = fanoutLayout("O", ["a", "b", "c"]);
    expect(t.t).toBe("split");
    expect(t.dir).toBe("row");
    expect(isLeaf(t.a) && t.a.agentId).toBe("O"); // orchestrator left
    expect(leaves(t).map((l) => l.agentId)).toEqual(["O", "a", "b", "c"]);
  });
  it("2 children stack on the right (top/bottom)", () => {
    const t = fanoutLayout("O", ["a", "b"]);
    expect(t.b.dir).toBe("col"); // right region split horizontally → stacked
    expect(isValidTree(t)).toBe(true);
  });
  it("4 children form a 2×2 on the right, orchestrator narrower (40%)", () => {
    const t = fanoutLayout("O", ["a", "b", "c", "d"]);
    const rects = computeRects(t);
    // orchestrator takes the left 40%
    expect(rects.find((r) => r.agentId === "O").rect).toMatchObject({ left: 0, width: 40, height: 100 });
    // children occupy the right 60% as four 30%×50% tiles
    const kids = rects.filter((r) => r.agentId !== "O");
    expect(kids).toHaveLength(4);
    for (const k of kids) {
      expect(k.rect.left).toBeGreaterThanOrEqual(40);
      expect(k.rect.width).toBeCloseTo(30);
      expect(k.rect.height).toBeCloseTo(50);
    }
  });
  it("6 children form a 3-over-3 grid on the right", () => {
    const t = fanoutLayout("O", ["a", "b", "c", "d", "e", "f"]);
    const kids = computeRects(t).filter((r) => r.agentId !== "O");
    expect(kids).toHaveLength(6);
    for (const k of kids) {
      expect(k.rect.width).toBeCloseTo(20); // 60% right / 3 cols
      expect(k.rect.height).toBeCloseTo(50); // 2 rows
    }
    expect(kids.filter((k) => k.rect.top === 0)).toHaveLength(3); // top row
    expect(kids.filter((k) => k.rect.top === 50)).toHaveLength(3); // bottom row
  });
  it("caps the fanout at 7 panes total", () => {
    const many = Array.from({ length: 20 }, (_, i) => "c" + i);
    expect(leafCount(fanoutLayout("O", many))).toBe(7);
  });
});

describe("stripAgents / fillAgents", () => {
  const struct = stripAgents(fanoutLayout("O", ["x", "y"])); // structure with 3 leaves

  it("stripAgents nulls every leaf, keeps the structure", () => {
    expect(leaves(struct).every((l) => l.agentId === null)).toBe(true);
    expect(struct.dir).toBe("row");
    expect(leafCount(struct)).toBe(3);
  });
  it("fills leaves in order", () => {
    expect(leaves(fillAgents(struct, ["a", "b", "c"])).map((l) => l.agentId)).toEqual(["a", "b", "c"]);
  });
  it("drops extra agents (more agents than panes)", () => {
    expect(leaves(fillAgents(struct, ["a", "b", "c", "d"])).map((l) => l.agentId)).toEqual(["a", "b", "c"]);
  });
  it("pads with empty panes (fewer agents than panes)", () => {
    expect(leaves(fillAgents(struct, ["a"])).map((l) => l.agentId)).toEqual(["a", null, null]);
  });
  it("regenerates fresh node ids", () => {
    expect(fillAgents(struct, ["a", "b", "c"]).id).not.toBe(struct.id);
  });
});

describe("isValidTree", () => {
  it("accepts leaves and splits, rejects junk", () => {
    const root = leaf("a");
    const split = splitLeaf(root, root.id, "row", "after", "b").tree;
    expect(isValidTree(root)).toBe(true);
    expect(isValidTree(split)).toBe(true);
    expect(isValidTree(null)).toBe(false);
    expect(isValidTree({ t: "weird" })).toBe(false);
  });
});
