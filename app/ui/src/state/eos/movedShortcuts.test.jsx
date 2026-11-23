import { describe, it, expect, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MovedShortcuts } from "../../views/eos/home/MovedShortcuts.jsx";
import { dismissShortcutsMoved, MOVED_KEY, noteViewAtStart } from "./movedShortcuts.js";

function stubStorage() {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k), data };
}

beforeEach(() => { globalThis.localStorage = stubStorage(); });

describe("the moved mode shortcuts", () => {
  it("are told once to a user who had another mode open, until dismissed", () => {
    noteViewAtStart("agents");
    expect(renderToStaticMarkup(<MovedShortcuts />)).toContain("Agents moved to");
    noteViewAtStart("agents");
    dismissShortcutsMoved();
    expect(renderToStaticMarkup(<MovedShortcuts />)).toBe("");
    expect(globalThis.localStorage.data.get(MOVED_KEY)).toBe("seen");
  });

  it("are never told to a new user or one already in Eos", () => {
    noteViewAtStart(null);
    expect(renderToStaticMarkup(<MovedShortcuts />)).toBe("");
    globalThis.localStorage = stubStorage();
    noteViewAtStart("eos");
    expect(renderToStaticMarkup(<MovedShortcuts />)).toBe("");
  });
});
