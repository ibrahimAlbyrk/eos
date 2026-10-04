import { describe, it, expect } from "vitest";
import { ownSignal, strongest, subtreeSignal } from "./rowSignal.js";

const node = (id, state, children = []) => ({ id, state, children });
const ctx = ({ waiting = [], unread = [] } = {}) => ({
  waiting: (w) => waiting.includes(w.id),
  unread: (w) => unread.includes(w.id),
});

describe("ownSignal", () => {
  it("is null for a quiet agent, so the row shows its age instead", () => {
    expect(ownSignal(node("a", "IDLE"), ctx())).toBe(null);
    expect(ownSignal(node("a", "DONE"), ctx())).toBe(null);
  });

  it("ranks input over unread over running", () => {
    const n = node("a", "WORKING");
    expect(ownSignal(n, ctx())).toBe("running");
    expect(ownSignal(n, ctx({ unread: ["a"] }))).toBe("unread");
    expect(ownSignal(n, ctx({ unread: ["a"], waiting: ["a"] }))).toBe("input");
  });
});

describe("strongest", () => {
  it("keeps the more urgent cue and treats null as nothing", () => {
    expect(strongest(null, null)).toBe(null);
    expect(strongest("running", null)).toBe("running");
    expect(strongest("running", "input")).toBe("input");
  });
});

describe("subtreeSignal", () => {
  it("surfaces a blocked sub-agent through an idle parent", () => {
    const tree = node("p", "IDLE", [node("c1", "WORKING"), node("c2", "IDLE", [node("g", "IDLE")])]);
    expect(subtreeSignal(tree, ctx())).toBe("running");
    expect(subtreeSignal(tree, ctx({ waiting: ["g"] }))).toBe("input");
  });
});
