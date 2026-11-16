import { describe, it, expect } from "vitest";
import { replyTargetOf, selectedPassage, withSelection } from "./replyTarget.js";

describe("replyTargetOf", () => {
  it("maps each message kind to the role of its author", () => {
    expect(replyTargetOf({ kind: "user", rowId: 1, text: "a", ts: 5 })).toEqual({ rowId: 1, role: "user", text: "a", ts: 5 });
    expect(replyTargetOf({ kind: "assistant", rowId: 2, text: "b", ts: 6 })?.role).toBe("assistant");
    expect(replyTargetOf({ kind: "report", rowId: 3, text: "c" })?.role).toBe("agent");
    expect(replyTargetOf({ kind: "directive", rowId: 4, text: "d" })?.role).toBe("agent");
  });

  it("refuses blocks with no durable row to point at", () => {
    expect(replyTargetOf({ kind: "user", text: "sending", optimistic: true })).toBeNull();
    expect(replyTargetOf({ kind: "assistant", text: "streaming" })).toBeNull();
    expect(replyTargetOf({ kind: "toolGroup", rowId: 9 })).toBeNull();
  });
});

describe("a reply to a selected passage", () => {
  const root = { contains: (node) => node === "inside" };
  const selection = (text, { within = "inside", collapsed = false } = {}) => ({
    isCollapsed: collapsed,
    rangeCount: 1,
    getRangeAt: () => ({
      commonAncestorContainer: within,
      // Two lines of selected text.
      getClientRects: () => [{ left: 10, right: 200, top: 10, bottom: 30 }, { left: 10, right: 80, top: 30, bottom: 50 }],
    }),
    toString: () => text,
  });

  it("takes the selection when the pointer is on it", () => {
    expect(selectedPassage(selection("  the plan\n"), root, 50, 40)).toBe("the plan");
  });

  it("takes the whole message when the pointer is elsewhere or nothing is selected", () => {
    expect(selectedPassage(selection("the plan"), root, 150, 40)).toBeNull();
    expect(selectedPassage(selection("the plan", { collapsed: true }), root, 50, 40)).toBeNull();
    expect(selectedPassage(selection("  "), root, 50, 40)).toBeNull();
    expect(selectedPassage(null, root, 50, 40)).toBeNull();
  });

  it("ignores a selection that reaches outside the message", () => {
    expect(selectedPassage(selection("the plan", { within: "outside" }), root, 50, 40)).toBeNull();
  });

  it("narrows the target to the passage", () => {
    const target = { rowId: 1, role: "assistant", text: "the whole message", ts: 5 };
    expect(withSelection(target, "whole")).toEqual({ ...target, selection: "whole" });
    expect(withSelection(target, null)).toBe(target);
  });
});
