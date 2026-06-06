import { describe, it, expect, beforeEach } from "vitest";
import { loadScrollPos, saveScrollPos, clearScrollPos } from "./scrollMemory.js";

function stubStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
  };
}

let storage;
beforeEach(() => { storage = stubStorage(); });

describe("scrollMemory", () => {
  it("returns null when nothing saved", () => {
    expect(loadScrollPos("a", storage)).toBe(null);
  });

  it("round-trips a saved position per agent", () => {
    saveScrollPos("a", 120, storage);
    saveScrollPos("b", 999, storage);
    expect(loadScrollPos("a", storage)).toBe(120);
    expect(loadScrollPos("b", storage)).toBe(999);
  });

  it("clear removes only the given agent", () => {
    saveScrollPos("a", 120, storage);
    saveScrollPos("b", 999, storage);
    clearScrollPos("a", storage);
    expect(loadScrollPos("a", storage)).toBe(null);
    expect(loadScrollPos("b", storage)).toBe(999);
  });

  it("survives corrupted storage payloads", () => {
    storage.setItem("cm:scrollPos", "{not json");
    expect(loadScrollPos("a", storage)).toBe(null);
    saveScrollPos("a", 50, storage);
    expect(loadScrollPos("a", storage)).toBe(50);
  });

  it("ignores falsy ids and missing storage", () => {
    expect(loadScrollPos(null, storage)).toBe(null);
    saveScrollPos(null, 10, storage);
    clearScrollPos(null, storage);
    expect(loadScrollPos("x", undefined)).toBe(null);
    saveScrollPos("x", 10, undefined);
    clearScrollPos("x", undefined);
  });

  it("prunes oldest entries past the cap, refreshing on re-save", () => {
    for (let i = 0; i < 50; i++) saveScrollPos("w" + i, i, storage);
    saveScrollPos("w0", 7, storage); // refresh w0 → w1 is now oldest
    saveScrollPos("new", 1, storage);
    expect(loadScrollPos("w1", storage)).toBe(null);
    expect(loadScrollPos("w0", storage)).toBe(7);
    expect(loadScrollPos("new", storage)).toBe(1);
  });
});
