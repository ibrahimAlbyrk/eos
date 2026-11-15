import { describe, it, expect } from "vitest";
import { shareBlocks, sameValue } from "./shareBlocks.js";

const keyOf = (b, i) => b.kind + "-" + (b.id ?? i);
const parse = (rows) => rows.map((r) => structuredClone(r));

describe("shareBlocks", () => {
  const rows = [
    { kind: "user", id: "u1", text: "hi", ts: 1 },
    { kind: "toolGroup", id: "g1", tools: [{ id: "t1", name: "Read", input: { file_path: "/a" }, result: null, running: true }], ts: 2 },
    { kind: "assistant", id: "a1", text: "done", ts: 3 },
  ];

  it("keeps the previous object for every unchanged block, in a new array", () => {
    const prev = parse(rows);
    const next = parse(rows);
    const out = shareBlocks(prev, next, keyOf);
    expect(out).not.toBe(prev);
    out.forEach((b, i) => expect(b).toBe(prev[i]));
  });

  it("gives a changed block its new object and keeps the rest", () => {
    const prev = parse(rows);
    const changed = parse(rows);
    changed[1].tools[0].running = false;
    changed[1].tools[0].result = { text: "ok" };
    const out = shareBlocks(prev, changed, keyOf);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(changed[1]);
    expect(out[2]).toBe(prev[2]);
  });

  it("shares across an append and a prepend (matched by key, not position)", () => {
    const prev = parse(rows);
    const next = parse([{ kind: "user", id: "u0", text: "older", ts: 0 }, ...rows, { kind: "assistant", id: "a2", text: "new", ts: 4 }]);
    const out = shareBlocks(prev, next, keyOf);
    expect(out[0]).toBe(next[0]);
    expect(out.slice(1, 4)).toEqual(prev);
    out.slice(1, 4).forEach((b, i) => expect(b).toBe(prev[i]));
    expect(out[4]).toBe(next[4]);
  });

  it("never hands one previous object to two blocks", () => {
    const keyByTs = (b) => b.kind + "-" + b.ts;
    const prev = parse([{ kind: "user", text: "hi", ts: 5 }]);
    const next = parse([{ kind: "user", text: "hi", ts: 5 }, { kind: "user", text: "hi", ts: 5 }]);
    const out = shareBlocks(prev, next, keyByTs);
    expect(out[0]).not.toBe(out[1]);
    // A key the previous parse held twice is not shared at all.
    const out2 = shareBlocks(next, parse(next), keyByTs);
    expect(out2[0]).not.toBe(next[0]);
    expect(out2[1]).not.toBe(next[1]);
  });

  it("answers the new list unchanged when there is nothing to share with", () => {
    const next = parse(rows);
    expect(shareBlocks(null, next, keyOf)).toBe(next);
    expect(shareBlocks([], next, keyOf)).toBe(next);
  });
});

describe("sameValue", () => {
  it("compares plain data deeply", () => {
    expect(sameValue({ a: [1, { b: "x" }], c: null }, { c: null, a: [1, { b: "x" }] })).toBe(true);
    expect(sameValue({ a: [1, 2] }, { a: [1, 2, 3] })).toBe(false);
    expect(sameValue({ a: undefined }, {})).toBe(false);
    expect(sameValue({ n: NaN }, { n: NaN })).toBe(true);
    expect(sameValue([1], { 0: 1, length: 1 })).toBe(false);
    expect(sameValue(new Map(), new Map())).toBe(false);
  });
});
