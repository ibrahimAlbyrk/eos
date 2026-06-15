import { describe, it, expect } from "vitest";
import {
  initUndo, recordCoalescing, recordDiscrete, settle, undo, redo, bound,
  canUndo, canRedo, UNDO_MAX,
} from "./undoStack.js";

// Snapshots are opaque to the stack — these tests use {text, cursorPos}.
const snap = (text, cursorPos = text.length) => ({ text, cursorPos });
const texts = (s) => s.snapshots.map((x) => x.text);

describe("initUndo", () => {
  it("starts with a single baseline and nothing to undo/redo", () => {
    const s = initUndo();
    expect(texts(s)).toEqual([""]);
    expect(s.index).toBe(0);
    expect(canUndo(s)).toBe(false);
    expect(canRedo(s)).toBe(false);
  });

  it("accepts a non-empty baseline (restored draft)", () => {
    const s = initUndo(snap("hello"));
    expect(texts(s)).toEqual(["hello"]);
    expect(canUndo(s)).toBe(false);
  });
});

describe("recordCoalescing", () => {
  it("opens a new checkpoint on the first edit of a burst", () => {
    let s = initUndo();
    s = recordCoalescing(s, snap("h"));
    expect(texts(s)).toEqual(["", "h"]);
    expect(s.index).toBe(1);
    expect(s.open).toBe(true);
    expect(canUndo(s)).toBe(true);
  });

  it("replaces the open top while the burst continues", () => {
    let s = initUndo();
    s = recordCoalescing(s, snap("h"));
    s = recordCoalescing(s, snap("he"));
    s = recordCoalescing(s, snap("hello"));
    expect(texts(s)).toEqual(["", "hello"]); // burst collapsed to one step
    expect(s.index).toBe(1);
  });

  it("opens a fresh checkpoint after settle closes the burst", () => {
    let s = initUndo();
    s = recordCoalescing(s, snap("hello"));
    s = settle(s);
    expect(s.open).toBe(false);
    s = recordCoalescing(s, snap("hello world"));
    expect(texts(s)).toEqual(["", "hello", "hello world"]);
    expect(s.index).toBe(2);
  });
});

describe("recordDiscrete", () => {
  it("always pushes a sealed checkpoint", () => {
    let s = initUndo();
    s = recordDiscrete(s, snap("/commit "));
    expect(texts(s)).toEqual(["", "/commit "]);
    expect(s.open).toBe(false);
    s = recordDiscrete(s, snap("/commit fix"));
    expect(texts(s)).toEqual(["", "/commit ", "/commit fix"]);
  });
});

describe("undo / redo", () => {
  it("walks back and forward through checkpoints", () => {
    let s = initUndo();
    s = recordDiscrete(s, snap("a"));
    s = recordDiscrete(s, snap("ab"));

    let r = undo(s);
    expect(r.snapshot.text).toBe("a");
    s = r.state;
    expect(s.index).toBe(1);

    r = undo(s);
    expect(r.snapshot.text).toBe("");
    s = r.state;
    expect(s.index).toBe(0);

    r = redo(s);
    expect(r.snapshot.text).toBe("a");
    s = r.state;
    expect(s.index).toBe(1);
  });

  it("returns a null snapshot at the baseline and at the top", () => {
    let s = initUndo();
    s = recordDiscrete(s, snap("a"));

    let r = undo(s);
    s = r.state;
    expect(undo(s).snapshot).toBe(null); // already at baseline

    r = redo(s);
    s = r.state;
    expect(redo(s).snapshot).toBe(null); // already at top
  });

  it("seals an open burst on undo so the whole burst reverts at once", () => {
    let s = initUndo();
    s = recordCoalescing(s, snap("h"));
    s = recordCoalescing(s, snap("hello")); // still open, timer pending
    const r = undo(s);
    expect(r.snapshot.text).toBe("");
    expect(r.state.open).toBe(false);
  });
});

describe("redo branch truncation", () => {
  it("drops the redo tail when a new edit follows an undo", () => {
    let s = initUndo();
    s = recordDiscrete(s, snap("a"));
    s = recordDiscrete(s, snap("ab"));
    s = undo(s).state; // back to "a", redo→"ab" available
    expect(canRedo(s)).toBe(true);

    s = recordDiscrete(s, snap("aX")); // diverge
    expect(texts(s)).toEqual(["", "a", "aX"]);
    expect(canRedo(s)).toBe(false);
  });

  it("coalescing after undo also kills the redo branch", () => {
    let s = initUndo();
    s = recordCoalescing(s, snap("a"));
    s = settle(s);
    s = recordCoalescing(s, snap("ab"));
    s = settle(s);
    s = undo(s).state; // at "a"
    s = recordCoalescing(s, snap("aY"));
    expect(texts(s)).toEqual(["", "a", "aY"]);
  });
});

describe("bound", () => {
  it("drops the oldest snapshots and keeps the index aligned", () => {
    let s = initUndo();
    for (let i = 1; i <= UNDO_MAX + 5; i++) s = recordDiscrete(s, snap("x".repeat(i)));
    s = bound(s);
    expect(s.snapshots.length).toBe(UNDO_MAX);
    // index stayed on the newest snapshot
    expect(s.snapshots[s.index].text).toBe("x".repeat(UNDO_MAX + 5));
  });

  it("is a no-op below the cap", () => {
    let s = initUndo();
    s = recordDiscrete(s, snap("a"));
    expect(bound(s)).toBe(s);
  });
});

describe("the report trace (h, e, llo · world)", () => {
  it("matches the documented behavior end to end", () => {
    let s = initUndo();
    s = recordCoalescing(s, snap("h"));
    s = recordCoalescing(s, snap("he"));
    s = recordCoalescing(s, snap("hello"));
    s = settle(s); // 0.3s pause
    s = recordCoalescing(s, snap("hello world"));

    expect(texts(s)).toEqual(["", "hello", "hello world"]);

    let r = undo(s);
    expect(r.snapshot.text).toBe("hello");
    r = undo(r.state);
    expect(r.snapshot.text).toBe("");
    r = redo(r.state);
    expect(r.snapshot.text).toBe("hello");
  });
});
