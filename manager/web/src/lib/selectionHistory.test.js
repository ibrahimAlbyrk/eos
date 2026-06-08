import { describe, it, expect } from "vitest";
import { pushSelection, takePrevious, SELECTION_HISTORY_CAP } from "./selectionHistory.js";

describe("pushSelection", () => {
  it("pushes the previous id", () => {
    expect(pushSelection([], "a", "b")).toEqual(["a"]);
  });

  it("is a no-op when prev === next", () => {
    const h = ["a"];
    expect(pushSelection(h, "b", "b")).toBe(h);
  });

  it("ignores a null previous (first selection)", () => {
    expect(pushSelection([], null, "a")).toEqual([]);
  });

  it("dedupes when re-selecting an earlier id", () => {
    expect(pushSelection(["a", "b"], "b", "a")).toEqual(["b"]);
  });

  it("removes a stale copy of prev before pushing it", () => {
    expect(pushSelection(["a", "b", "c"], "a", "d")).toEqual(["b", "c", "a"]);
  });

  it("caps length, dropping the oldest", () => {
    const big = Array.from({ length: SELECTION_HISTORY_CAP }, (_, i) => `id${i}`);
    const out = pushSelection(big, "prev", "next", SELECTION_HISTORY_CAP);
    expect(out.length).toBe(SELECTION_HISTORY_CAP);
    expect(out[0]).toBe("id1");
    expect(out[out.length - 1]).toBe("prev");
  });
});

describe("takePrevious", () => {
  const all = (ids) => (id) => ids.includes(id);

  it("returns the most-recent surviving id and trims it", () => {
    expect(takePrevious(["a", "b"], all(["a", "b"]), "c")).toEqual({ id: "b", history: ["a"] });
  });

  it("skips dead entries", () => {
    expect(takePrevious(["a", "b", "c"], all(["a"]), "x")).toEqual({ id: "a", history: [] });
  });

  it("skips the current id", () => {
    expect(takePrevious(["a", "b"], all(["a", "b"]), "b").id).toBe("a");
  });

  it("returns null when nothing survives", () => {
    expect(takePrevious(["a", "b"], all([]), "x")).toEqual({ id: null, history: [] });
  });

  it("returns null for empty history", () => {
    expect(takePrevious([], all(["a"]), "a")).toEqual({ id: null, history: [] });
  });

  it("does not mutate the input", () => {
    const h = ["a", "b"];
    takePrevious(h, all(["a", "b"]), "c");
    expect(h).toEqual(["a", "b"]);
  });

  it("treats a missing predicate as 'all exist'", () => {
    expect(takePrevious(["a", "b"], undefined, "c").id).toBe("b");
  });
});

// The delete-and-fall-back chain self-prunes dead entries across levels.
describe("delete chain", () => {
  it("walks back through a multi-level selection chain", () => {
    let history = [];
    history = pushSelection(history, null, "a");
    history = pushSelection(history, "a", "b");
    history = pushSelection(history, "b", "c");
    expect(history).toEqual(["a", "b"]);

    const live = new Set(["a", "b", "c"]);
    const exists = (id) => live.has(id);

    // delete c (selected) → fall back to b
    let r = takePrevious(history, exists, "c");
    expect(r.id).toBe("b");
    live.delete("c");
    history = pushSelection(r.history, "c", "b");
    expect(history).toEqual(["a", "c"]);

    // delete b → c is dead, fall back to a
    r = takePrevious(history, exists, "b");
    expect(r.id).toBe("a");
    live.delete("b");
    history = pushSelection(r.history, "b", "a");

    // delete a → nothing left
    r = takePrevious(history, exists, "a");
    expect(r.id).toBeNull();
  });
});
