import { describe, it, expect, beforeEach } from "vitest";
import { getReplyTarget, setReplyTarget, clearReplyTarget, _reset } from "./replyStore.js";

beforeEach(() => _reset());

describe("replyStore", () => {
  it("keeps one target per worker", () => {
    setReplyTarget("w1", { rowId: 1 });
    setReplyTarget("w2", { rowId: 2 });
    expect(getReplyTarget("w1")).toEqual({ rowId: 1 });
    expect(getReplyTarget("w2")).toEqual({ rowId: 2 });
  });

  it("a new reply replaces the previous one; clear drops it", () => {
    setReplyTarget("w1", { rowId: 1 });
    setReplyTarget("w1", { rowId: 3 });
    expect(getReplyTarget("w1")).toEqual({ rowId: 3 });
    clearReplyTarget("w1");
    expect(getReplyTarget("w1")).toBeNull();
  });
});
