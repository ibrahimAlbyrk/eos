import { describe, it, expect } from "vitest";
import { parseHistory, recallUp, recallDown, commit, HISTORY_MAX } from "./inputHistory.js";

describe("parseHistory", () => {
  it("returns [] for null/empty raw", () => {
    expect(parseHistory(null)).toEqual([]);
    expect(parseHistory("")).toEqual([]);
  });

  it("returns [] for garbage JSON", () => {
    expect(parseHistory("{not json")).toEqual([]);
  });

  it("returns [] for non-array JSON", () => {
    expect(parseHistory('{"a":1}')).toEqual([]);
  });

  it("drops non-string entries", () => {
    expect(parseHistory('["a", 1, null, "b"]')).toEqual(["a", "b"]);
  });

  it("caps at HISTORY_MAX", () => {
    const big = JSON.stringify(Array.from({ length: HISTORY_MAX + 10 }, (_, i) => `m${i}`));
    expect(parseHistory(big)).toHaveLength(HISTORY_MAX);
  });
});

describe("recallUp", () => {
  const entries = ["newest", "middle", "oldest"];

  it("does nothing when not navigating and input has text", () => {
    expect(recallUp({ entries, index: null }, "draft")).toEqual({ index: null, recalled: null });
  });

  it("does nothing when history is empty", () => {
    expect(recallUp({ entries: [], index: null }, "")).toEqual({ index: null, recalled: null });
  });

  it("starts at newest when input is empty", () => {
    expect(recallUp({ entries, index: null }, "")).toEqual({ index: 0, recalled: "newest" });
  });

  it("walks to older entries", () => {
    expect(recallUp({ entries, index: 0 }, "newest")).toEqual({ index: 1, recalled: "middle" });
    expect(recallUp({ entries, index: 1 }, "middle")).toEqual({ index: 2, recalled: "oldest" });
  });

  it("clamps at oldest", () => {
    expect(recallUp({ entries, index: 2 }, "oldest")).toEqual({ index: 2, recalled: "oldest" });
  });

  it("detaches when the recalled entry was edited", () => {
    expect(recallUp({ entries, index: 1 }, "middle edited")).toEqual({ index: null, recalled: null });
  });

  it("restarts from newest when text was cleared mid-navigation", () => {
    expect(recallUp({ entries, index: 1 }, "")).toEqual({ index: 0, recalled: "newest" });
  });
});

describe("recallDown", () => {
  const entries = ["newest", "middle", "oldest"];

  it("does nothing when not navigating", () => {
    expect(recallDown({ entries, index: null }, "draft")).toEqual({ index: null, recalled: null });
  });

  it("walks to newer entries", () => {
    expect(recallDown({ entries, index: 2 }, "oldest")).toEqual({ index: 1, recalled: "middle" });
  });

  it("exits past newest by restoring empty input", () => {
    expect(recallDown({ entries, index: 0 }, "newest")).toEqual({ index: null, recalled: "" });
  });

  it("detaches when the recalled entry was edited", () => {
    expect(recallDown({ entries, index: 1 }, "middle edited")).toEqual({ index: null, recalled: null });
  });
});

describe("up/down round trip", () => {
  it("up, up, down, down returns to empty input", () => {
    const entries = ["a", "b"];
    let state = { entries, index: null };

    let r = recallUp(state, "");
    expect(r.recalled).toBe("a");
    state = { entries, index: r.index };

    r = recallUp(state, "a");
    expect(r.recalled).toBe("b");
    state = { entries, index: r.index };

    r = recallDown(state, "b");
    expect(r.recalled).toBe("a");
    state = { entries, index: r.index };

    r = recallDown(state, "a");
    expect(r).toEqual({ index: null, recalled: "" });
  });
});

describe("commit", () => {
  it("ignores empty/whitespace text", () => {
    const entries = ["a"];
    expect(commit(entries, "")).toBe(entries);
    expect(commit(entries, "   ")).toBe(entries);
  });

  it("returns the same reference on consecutive duplicate", () => {
    const entries = ["a", "b"];
    expect(commit(entries, "a")).toBe(entries);
  });

  it("trims and prepends new entries", () => {
    expect(commit(["a"], "  b  ")).toEqual(["b", "a"]);
  });

  it("allows non-consecutive duplicates", () => {
    expect(commit(["a", "b"], "b")).toEqual(["b", "a", "b"]);
  });

  it("caps at max", () => {
    const full = Array.from({ length: 3 }, (_, i) => `m${i}`);
    expect(commit(full, "new", 3)).toEqual(["new", "m0", "m1"]);
  });
});
