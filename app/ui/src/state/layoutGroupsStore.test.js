import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getLayoutGroups, addGroup, updateGroup, renameGroup, deleteGroup, setActiveGroup,
  _resetLayoutGroups,
} from "./layoutGroupsStore.js";

function stubStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

// Plain-object BSP trees — the store validates shape via isValidTree, so we don't
// need paneLayout's id-minting here.
let idc = 0;
const lf = (agentId = null) => ({ t: "leaf", id: `L${idc++}`, agentId });
const split = (dir, a, b, ratio = 0.5) => ({ t: "split", id: `S${idc++}`, dir, ratio, a, b });
const chain = (n) => { let node = lf(); for (let i = 1; i < n; i++) node = split("row", lf(), node); return node; };

beforeEach(() => {
  idc = 0;
  _resetLayoutGroups();
  globalThis.localStorage = stubStorage();
});
afterEach(() => {
  delete globalThis.localStorage;
});

describe("layoutGroupsStore", () => {
  it("starts empty", () => {
    expect(getLayoutGroups()).toEqual({ groups: [], activeGroupId: null });
  });

  it("addGroup stores name (trimmed) + tree + savedAt with a unique id", () => {
    const tree = split("row", lf("a"), lf("b"));
    const id1 = addGroup("  Split  ", tree);
    const id2 = addGroup("Solo", lf("c"));
    expect(id1).not.toBe(id2);
    const { groups } = getLayoutGroups();
    expect(groups.map((g) => g.name)).toEqual(["Split", "Solo"]);
    expect(groups[0].tree).toBe(tree);
    expect(typeof groups[0].savedAt).toBe("number");
  });

  it("addGroup rejects blank names and non-tree snapshots", () => {
    expect(addGroup("   ", lf())).toBeNull();
    expect(addGroup("Bad", { nope: true })).toBeNull();
    expect(getLayoutGroups().groups).toEqual([]);
  });

  it("addGroup rejects a snapshot with more than MAX_PANES leaves", () => {
    expect(addGroup("TooMany", chain(10))).toBeNull();
    expect(addGroup("Ok", chain(9))).not.toBeNull();
    expect(getLayoutGroups().groups.map((g) => g.name)).toEqual(["Ok"]);
  });

  it("updateGroup swaps the saved tree in place", () => {
    const id = addGroup("Work", lf("a"));
    const next = split("col", lf("a"), lf("b"));
    updateGroup(id, next);
    expect(getLayoutGroups().groups[0].tree).toBe(next);
  });

  it("renameGroup trims and ignores blanks", () => {
    const id = addGroup("Work", lf("a"));
    renameGroup(id, "  Renamed  ");
    expect(getLayoutGroups().groups[0].name).toBe("Renamed");
    renameGroup(id, "   ");
    expect(getLayoutGroups().groups[0].name).toBe("Renamed");
  });

  it("deleteGroup removes the group and clears it if active", () => {
    const id = addGroup("Work", lf("a"));
    setActiveGroup(id);
    expect(getLayoutGroups().activeGroupId).toBe(id);
    deleteGroup(id);
    expect(getLayoutGroups()).toEqual({ groups: [], activeGroupId: null });
  });

  it("setActiveGroup sets and clears the active pointer", () => {
    const id = addGroup("Work", lf("a"));
    setActiveGroup(id);
    expect(getLayoutGroups().activeGroupId).toBe(id);
    setActiveGroup(null);
    expect(getLayoutGroups().activeGroupId).toBeNull();
  });

  it("persists groups + activeGroupId and rehydrates after reload", () => {
    const tree = split("row", lf("a"), lf("b"));
    const id = addGroup("Work", tree);
    setActiveGroup(id);
    _resetLayoutGroups();
    const snap = getLayoutGroups();
    expect(snap.groups.map((g) => g.name)).toEqual(["Work"]);
    expect(snap.groups[0].tree).toEqual(tree); // JSON round-trip preserves ids + agents
    expect(snap.activeGroupId).toBe(id);
  });

  it("drops a dangling activeGroupId on rehydrate", () => {
    addGroup("Work", lf("a"));
    setActiveGroup("g999"); // never a real id
    _resetLayoutGroups();
    expect(getLayoutGroups().activeGroupId).toBeNull();
  });

  it("keeps minting fresh ids after a rehydrate (no collision)", () => {
    const g = addGroup("Work", lf("a"));
    _resetLayoutGroups();
    getLayoutGroups(); // trigger hydrate
    const g2 = addGroup("Play", lf("b"));
    expect(g2).not.toBe(g);
  });

  it("hydrate discards corrupt / oversized persisted groups", () => {
    globalThis.localStorage.setItem("cm:layoutGroups", JSON.stringify({
      groups: [
        { id: "g1", name: "Good", tree: lf("a"), savedAt: 1 },
        { id: "g2", name: "NoTree" },
        { id: "g3", name: "TooMany", tree: chain(10), savedAt: 2 },
      ],
      activeGroupId: "g1",
    }));
    const { groups } = getLayoutGroups();
    expect(groups.map((g) => g.name)).toEqual(["Good"]);
  });
});
