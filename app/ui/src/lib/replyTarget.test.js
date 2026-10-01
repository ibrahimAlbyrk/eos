import { describe, it, expect } from "vitest";
import { replyTargetOf } from "./replyTarget.js";

describe("replyTargetOf", () => {
  it("maps each message kind to the role of its author", () => {
    expect(replyTargetOf({ kind: "user", rowId: 1, text: "a", ts: 5 })).toEqual({ rowId: 1, role: "user", text: "a", ts: 5 });
    expect(replyTargetOf({ kind: "assistant", rowId: 2, text: "b", ts: 6 })?.role).toBe("assistant");
    expect(replyTargetOf({ kind: "report", rowId: 3, text: "c" })?.role).toBe("agent");
    expect(replyTargetOf({ kind: "loop", rowId: 4, text: "d" })?.role).toBe("system");
  });

  it("refuses blocks with no durable row to point at", () => {
    expect(replyTargetOf({ kind: "user", text: "sending", optimistic: true })).toBeNull();
    expect(replyTargetOf({ kind: "assistant", text: "streaming" })).toBeNull();
    expect(replyTargetOf({ kind: "toolGroup", rowId: 9 })).toBeNull();
  });
});
