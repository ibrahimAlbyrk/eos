import { describe, it, expect } from "vitest";
import { keepIfSame, clearPopoverData } from "./selection.jsx";

describe("selection updaters", () => {
  it("a republished verdict or question with the same data keeps the held object", () => {
    const held = { workerId: "w", verdict: "passed", command: "npm test", ts: 1, children: { c: { verdict: "failed", command: "x", ts: 2 } } };
    expect(keepIfSame(held, structuredClone(held))).toBe(held);
    const changed = { ...held, children: { c: { verdict: "passed", command: "x", ts: 3 } } };
    expect(keepIfSame(held, changed)).toBe(changed);
    const q = { toolUseId: "t1", questions: [{ question: "Which?", options: [{ label: "A" }] }] };
    expect(keepIfSame(q, structuredClone(q))).toBe(q);
    expect(keepIfSame(q, null)).toBe(null);
    expect(keepIfSame(null, q)).toBe(q);
  });

  it("closing popovers clears their data only when there is some", () => {
    const empty = {};
    expect(clearPopoverData(empty)).toBe(empty);
    expect(clearPopoverData({ agentId: "w" })).toEqual({});
  });
});
