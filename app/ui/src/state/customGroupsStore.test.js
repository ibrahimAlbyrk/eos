import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getCustomGroups, addGroup, moveAgent, _resetCustomGroups,
} from "./customGroupsStore.js";

function stubStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

beforeEach(() => {
  _resetCustomGroups();
  globalThis.localStorage = stubStorage();
});
afterEach(() => {
  delete globalThis.localStorage;
});

describe("customGroupsStore", () => {
  it("starts empty", () => {
    expect(getCustomGroups()).toEqual({ groups: [], assignments: {} });
  });

  it("addGroup creates a group with a unique id and trims the name", () => {
    const id1 = addGroup("  Work  ");
    const id2 = addGroup("Play");
    expect(id1).not.toBe(id2);
    expect(getCustomGroups().groups).toEqual([{ id: id1, name: "Work" }, { id: id2, name: "Play" }]);
  });

  it("addGroup rejects blank names", () => {
    expect(addGroup("   ")).toBeNull();
    expect(getCustomGroups().groups).toEqual([]);
  });

  it("moveAgent assigns and reassigns; null unassigns", () => {
    const g = addGroup("Work");
    moveAgent("a1", g);
    expect(getCustomGroups().assignments).toEqual({ a1: g });
    moveAgent("a1", null);
    expect(getCustomGroups().assignments).toEqual({});
  });

  it("persists groups + assignments and rehydrates after reload", () => {
    const g = addGroup("Work");
    moveAgent("a1", g);
    _resetCustomGroups();
    const snap = getCustomGroups();
    expect(snap.groups).toEqual([{ id: g, name: "Work" }]);
    expect(snap.assignments).toEqual({ a1: g });
  });

  it("keeps minting fresh ids after a rehydrate (no collision)", () => {
    const g = addGroup("Work");
    _resetCustomGroups();
    getCustomGroups(); // trigger hydrate
    const g2 = addGroup("Play");
    expect(g2).not.toBe(g);
  });
});
