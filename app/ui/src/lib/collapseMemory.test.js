import { describe, it, expect, beforeEach } from "vitest";
import { loadCollapsedNodes, saveCollapsedNodes } from "./collapseMemory.js";

function stubStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

let storage;
beforeEach(() => { storage = stubStorage(); });

describe("collapseMemory", () => {
  it("returns an empty set when nothing saved", () => {
    expect(loadCollapsedNodes(storage)).toEqual(new Set());
  });

  it("round-trips a saved set", () => {
    saveCollapsedNodes(new Set(["a", "b"]), storage);
    expect(loadCollapsedNodes(storage)).toEqual(new Set(["a", "b"]));
  });

  it("survives corrupted or non-array payloads", () => {
    storage.setItem("cm:collapsedNodes", "{not json");
    expect(loadCollapsedNodes(storage)).toEqual(new Set());
    storage.setItem("cm:collapsedNodes", JSON.stringify({ a: 1 }));
    expect(loadCollapsedNodes(storage)).toEqual(new Set());
  });

  it("filters non-string entries", () => {
    storage.setItem("cm:collapsedNodes", JSON.stringify(["a", 1, null, "b"]));
    expect(loadCollapsedNodes(storage)).toEqual(new Set(["a", "b"]));
  });

  it("removes the key when saving an empty set", () => {
    saveCollapsedNodes(new Set(["a"]), storage);
    saveCollapsedNodes(new Set(), storage);
    expect(storage.getItem("cm:collapsedNodes")).toBe(null);
  });

  it("drops the oldest entries past the cap", () => {
    const big = new Set();
    for (let i = 0; i < 250; i++) big.add("w" + i);
    saveCollapsedNodes(big, storage);
    const loaded = loadCollapsedNodes(storage);
    expect(loaded.size).toBe(200);
    expect(loaded.has("w49")).toBe(false);
    expect(loaded.has("w50")).toBe(true);
    expect(loaded.has("w249")).toBe(true);
  });

  it("tolerates missing storage", () => {
    expect(loadCollapsedNodes(undefined)).toEqual(new Set());
    saveCollapsedNodes(new Set(["a"]), undefined);
  });
});
