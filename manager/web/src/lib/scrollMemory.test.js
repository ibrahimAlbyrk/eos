import { describe, it, expect, beforeEach } from "vitest";
import { loadScrollPos, saveScrollPos, clearScrollPos } from "./scrollMemory.js";

function stubStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
  };
}

const anchor = (key, offset = 0) => ({ key, offset });

let storage;
beforeEach(() => { storage = stubStorage(); });

describe("scrollMemory", () => {
  it("returns null when nothing saved", () => {
    expect(loadScrollPos("a", storage)).toBe(null);
  });

  it("round-trips a saved anchor per agent", () => {
    saveScrollPos("a", anchor("t-1", -12), storage);
    saveScrollPos("b", anchor("user-99", 0), storage);
    expect(loadScrollPos("a", storage)).toEqual({ key: "t-1", offset: -12 });
    expect(loadScrollPos("b", storage)).toEqual({ key: "user-99", offset: 0 });
  });

  it("clear removes only the given agent", () => {
    saveScrollPos("a", anchor("t-1"), storage);
    saveScrollPos("b", anchor("t-2"), storage);
    clearScrollPos("a", storage);
    expect(loadScrollPos("a", storage)).toBe(null);
    expect(loadScrollPos("b", storage)).toEqual({ key: "t-2", offset: 0 });
  });

  it("ignores legacy numeric entries and malformed anchors", () => {
    storage.setItem("cm:scrollPos", JSON.stringify({ a: 120, b: { key: 5, offset: 0 }, c: { key: "x", offset: NaN } }));
    expect(loadScrollPos("a", storage)).toBe(null);
    expect(loadScrollPos("b", storage)).toBe(null);
    expect(loadScrollPos("c", storage)).toBe(null);
  });

  it("survives corrupted storage payloads", () => {
    storage.setItem("cm:scrollPos", "{not json");
    expect(loadScrollPos("a", storage)).toBe(null);
    saveScrollPos("a", anchor("t-9", 4), storage);
    expect(loadScrollPos("a", storage)).toEqual({ key: "t-9", offset: 4 });
  });

  it("ignores falsy ids and missing storage", () => {
    expect(loadScrollPos(null, storage)).toBe(null);
    saveScrollPos(null, anchor("x"), storage);
    clearScrollPos(null, storage);
    expect(loadScrollPos("x", undefined)).toBe(null);
    saveScrollPos("x", anchor("x"), undefined);
    clearScrollPos("x", undefined);
  });

  it("prunes oldest entries past the cap, refreshing on re-save", () => {
    for (let i = 0; i < 50; i++) saveScrollPos("w" + i, anchor("k" + i), storage);
    saveScrollPos("w0", anchor("k0b"), storage); // refresh w0 → w1 is now oldest
    saveScrollPos("new", anchor("kn"), storage);
    expect(loadScrollPos("w1", storage)).toBe(null);
    expect(loadScrollPos("w0", storage)).toEqual({ key: "k0b", offset: 0 });
    expect(loadScrollPos("new", storage)).toEqual({ key: "kn", offset: 0 });
  });
});
