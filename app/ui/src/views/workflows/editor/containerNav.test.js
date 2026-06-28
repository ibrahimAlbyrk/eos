import { describe, it, expect } from "vitest";
import { isEnterableKind, doubleClickAction } from "./containerNav.js";

describe("isEnterableKind", () => {
  it("treats only loop as an enterable container", () => {
    expect(isEnterableKind("loop")).toBe(true);
    expect(isEnterableKind("subGraph")).toBe(false);
    expect(isEnterableKind("worker")).toBe(false);
    expect(isEnterableKind("input")).toBe(false);
  });
});

describe("doubleClickAction", () => {
  it("ENTERS a node body from the pointerdown hit — independent of e.target / read-only", () => {
    // The node id comes from the pointerdown hit, so entry fires even though WebKit
    // would have made the dblclick's e.target the surface. Works read-only too.
    expect(doubleClickAction({ downNodeId: "loop-3" })).toEqual({ type: "enter", nodeId: "loop-3" });
    expect(doubleClickAction({ downNodeId: "loop-3", readOnly: true })).toEqual({ type: "enter", nodeId: "loop-3" });
  });

  it("quick-adds on empty canvas only when editable", () => {
    expect(doubleClickAction({ downNodeId: null })).toEqual({ type: "quickAdd" });
    expect(doubleClickAction({ downNodeId: null, readOnly: true })).toEqual({ type: "none" });
    expect(doubleClickAction({ downNodeId: null, onEdge: true })).toEqual({ type: "none" });
  });
});
