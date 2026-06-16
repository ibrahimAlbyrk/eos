import { describe, it, expect } from "vitest";
import { parseHistory, recallUp, recallDown, commit, HISTORY_MAX } from "./inputHistory.js";

const E = (text, mode = "chat") => ({ text, mode });

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

  it("normalizes legacy string entries to chat mode", () => {
    expect(parseHistory('["a", "b"]')).toEqual([E("a"), E("b")]);
  });

  it("keeps valid mode-tagged entries", () => {
    expect(parseHistory('[{"text":"ls","mode":"term"},{"text":"rebase","mode":"git"}]'))
      .toEqual([E("ls", "term"), E("rebase", "git")]);
  });

  it("drops invalid entries", () => {
    const raw = '[{"text":"x","mode":"term"}, {"text":"y","mode":"weird"}, {"mode":"chat"}, 1, null, "z"]';
    expect(parseHistory(raw)).toEqual([E("x", "term"), E("z")]);
  });

  it("caps at HISTORY_MAX", () => {
    const big = JSON.stringify(Array.from({ length: HISTORY_MAX + 10 }, (_, i) => `m${i}`));
    expect(parseHistory(big)).toHaveLength(HISTORY_MAX);
  });
});

describe("recallUp", () => {
  const entries = [E("newest"), E("middle", "term"), E("oldest", "git")];

  it("does nothing when not navigating and input has text", () => {
    expect(recallUp({ entries, index: null, origin: null }, { text: "draft", mode: "chat" }))
      .toEqual({ index: null, origin: null, recalled: null });
  });

  it("does nothing when history is empty", () => {
    expect(recallUp({ entries: [], index: null, origin: null }, { text: "", mode: "chat" }))
      .toEqual({ index: null, origin: null, recalled: null });
  });

  it("starts at newest when input is empty, stashing the current mode as origin", () => {
    expect(recallUp({ entries, index: null, origin: null }, { text: "", mode: "term" }))
      .toEqual({ index: 0, origin: E("", "term"), recalled: E("newest") });
  });

  it("walks to older entries, carrying origin", () => {
    const origin = E("", "chat");
    expect(recallUp({ entries, index: 0, origin }, { text: "newest", mode: "chat" }))
      .toEqual({ index: 1, origin, recalled: E("middle", "term") });
    expect(recallUp({ entries, index: 1, origin }, { text: "middle", mode: "term" }))
      .toEqual({ index: 2, origin, recalled: E("oldest", "git") });
  });

  it("clamps at oldest", () => {
    const origin = E("", "chat");
    expect(recallUp({ entries, index: 2, origin }, { text: "oldest", mode: "git" }))
      .toEqual({ index: 2, origin, recalled: E("oldest", "git") });
  });

  it("detaches when the recalled entry's text was edited", () => {
    expect(recallUp({ entries, index: 1, origin: E("", "chat") }, { text: "middle edited", mode: "term" }))
      .toEqual({ index: null, origin: null, recalled: null });
  });

  it("does not detach on a mode toggle alone", () => {
    const origin = E("", "chat");
    expect(recallUp({ entries, index: 1, origin }, { text: "middle", mode: "chat" }))
      .toEqual({ index: 2, origin, recalled: E("oldest", "git") });
  });

  it("restarts from newest when text was cleared mid-navigation, re-stashing origin", () => {
    expect(recallUp({ entries, index: 1, origin: E("", "chat") }, { text: "", mode: "term" }))
      .toEqual({ index: 0, origin: E("", "term"), recalled: E("newest") });
  });
});

describe("recallDown", () => {
  const entries = [E("newest"), E("middle", "term"), E("oldest", "git")];

  it("does nothing when not navigating", () => {
    expect(recallDown({ entries, index: null, origin: null }, { text: "draft", mode: "chat" }))
      .toEqual({ index: null, origin: null, recalled: null });
  });

  it("walks to newer entries", () => {
    const origin = E("", "chat");
    expect(recallDown({ entries, index: 2, origin }, { text: "oldest", mode: "git" }))
      .toEqual({ index: 1, origin, recalled: E("middle", "term") });
  });

  it("exits past newest by restoring the origin state", () => {
    expect(recallDown({ entries, index: 0, origin: E("", "term") }, { text: "newest", mode: "chat" }))
      .toEqual({ index: null, origin: null, recalled: E("", "term") });
  });

  it("exit falls back to empty chat when origin is missing", () => {
    expect(recallDown({ entries, index: 0, origin: null }, { text: "newest", mode: "chat" }))
      .toEqual({ index: null, origin: null, recalled: E("") });
  });

  it("detaches when the recalled entry's text was edited", () => {
    expect(recallDown({ entries, index: 1, origin: E("", "chat") }, { text: "middle edited", mode: "term" }))
      .toEqual({ index: null, origin: null, recalled: null });
  });
});

describe("up/down round trip", () => {
  it("up, up, down, down returns to the origin state", () => {
    const entries = [E("a"), E("b", "term")];
    let state = { entries, index: null, origin: null };

    let r = recallUp(state, { text: "", mode: "git" });
    expect(r.recalled).toEqual(E("a"));
    state = { entries, index: r.index, origin: r.origin };

    r = recallUp(state, { text: "a", mode: "chat" });
    expect(r.recalled).toEqual(E("b", "term"));
    state = { entries, index: r.index, origin: r.origin };

    r = recallDown(state, { text: "b", mode: "term" });
    expect(r.recalled).toEqual(E("a"));
    state = { entries, index: r.index, origin: r.origin };

    r = recallDown(state, { text: "a", mode: "chat" });
    expect(r).toEqual({ index: null, origin: null, recalled: E("", "git") });
  });
});

describe("commit", () => {
  it("ignores empty/whitespace text", () => {
    const entries = [E("a")];
    expect(commit(entries, E(""))).toBe(entries);
    expect(commit(entries, E("   "))).toBe(entries);
  });

  it("returns the same reference on consecutive duplicate (same text and mode)", () => {
    const entries = [E("a", "term"), E("b")];
    expect(commit(entries, E("a", "term"))).toBe(entries);
  });

  it("keeps a consecutive duplicate text when the mode differs", () => {
    expect(commit([E("a", "term")], E("a"))).toEqual([E("a"), E("a", "term")]);
  });

  it("trims and prepends new entries", () => {
    expect(commit([E("a")], E("  b  ", "term"))).toEqual([E("b", "term"), E("a")]);
  });

  it("allows non-consecutive duplicates", () => {
    expect(commit([E("a"), E("b")], E("b"))).toEqual([E("b"), E("a"), E("b")]);
  });

  it("caps at max", () => {
    const full = Array.from({ length: 3 }, (_, i) => E(`m${i}`));
    expect(commit(full, E("new"), 3)).toEqual([E("new"), E("m0"), E("m1")]);
  });
});
