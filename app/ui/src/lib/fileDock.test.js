import { describe, it, expect } from "vitest";
import { EMPTY_DOCK, currentFile, peekFile, stepFile, closeDock, dropFile, setDockHeight, toggleDockMax, restoreDock } from "./fileDock.js";

const peekAll = (...paths) => paths.reduce(peekFile, EMPTY_DOCK);

describe("fileDock", () => {
  it("peeking opens the dock on that file", () => {
    const d = peekFile(EMPTY_DOCK, "/a.js");
    expect(d).toMatchObject({ open: true, history: ["/a.js"], index: 0 });
    expect(currentFile(d)).toBe("/a.js");
  });

  it("re-peeking a file moves it to the end instead of duplicating it", () => {
    const d = peekAll("/a.js", "/b.png", "/a.js");
    expect(d.history).toEqual(["/b.png", "/a.js"]);
    expect(currentFile(d)).toBe("/a.js");
  });

  it("steps back and forward within the history, no-op past either end", () => {
    let d = peekAll("/a.js", "/b.png");
    d = stepFile(d, -1);
    expect(currentFile(d)).toBe("/a.js");
    expect(stepFile(d, -1)).toBe(d);
    d = stepFile(d, 1);
    expect(currentFile(d)).toBe("/b.png");
    expect(stepFile(d, 1)).toBe(d);
  });

  it("peeking after going back drops the forward entries", () => {
    const d = peekFile(stepFile(peekAll("/a.js", "/b.png", "/c.md"), -2), "/d.ts");
    expect(d.history).toEqual(["/a.js", "/d.ts"]);
    expect(currentFile(d)).toBe("/d.ts");
  });

  it("caps the history, dropping the oldest", () => {
    const d = peekAll(...Array.from({ length: 35 }, (_, i) => `/f${i}`));
    expect(d.history).toHaveLength(30);
    expect(d.history[0]).toBe("/f5");
    expect(currentFile(d)).toBe("/f34");
  });

  it("closing keeps the history and drops maximize", () => {
    const d = closeDock(toggleDockMax(peekAll("/a.js")));
    expect(d).toMatchObject({ open: false, max: false, history: ["/a.js"], index: 0 });
    expect(closeDock(d)).toBe(d);
    expect(peekFile(d, "/a.js").open).toBe(true);
  });

  it("dropping the shown file shows its neighbor; dropping the last closes the dock", () => {
    let d = stepFile(peekAll("/a.js", "/b.png", "/c.md"), -1);
    d = dropFile(d, "/b.png");
    expect(d.history).toEqual(["/a.js", "/c.md"]);
    expect(currentFile(d)).toBe("/c.md");
    d = dropFile(d, "/a.js");
    expect(currentFile(d)).toBe("/c.md");
    d = dropFile(d, "/c.md");
    expect(d).toMatchObject({ open: false, history: [], index: -1 });
    expect(dropFile(d, "/x")).toBe(d);
  });

  it("keeps a height only inside (0, 1)", () => {
    expect(setDockHeight(EMPTY_DOCK, 0.6).height).toBe(0.6);
    expect(setDockHeight(EMPTY_DOCK, 1).height).toBe(null);
    expect(setDockHeight(EMPTY_DOCK, null).height).toBe(null);
  });

  it("restores a persisted dock and drops malformed fields", () => {
    expect(restoreDock({ open: true, history: ["/a", 3, "/b"], index: 0, height: 0.5, max: true }))
      .toEqual({ open: true, history: ["/a", "/b"], index: 0, height: 0.5, max: true });
    expect(restoreDock({ open: true, history: [], index: 4, height: 7 }))
      .toEqual({ open: false, history: [], index: -1, height: null, max: false });
    expect(restoreDock({ history: ["/a", "/b"], index: 9 }).index).toBe(1);
    expect(restoreDock(null)).toBe(EMPTY_DOCK);
  });
});
