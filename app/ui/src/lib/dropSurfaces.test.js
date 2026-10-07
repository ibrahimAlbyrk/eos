import { describe, it, expect, beforeAll, afterEach } from "vitest";

// nativeBridge touches window/document — stub before import (node env). Nodes
// mimic just what routing reads: parentNode + contains.
const listeners = [];
const node = (parentNode = null) => {
  const n = {
    parentNode,
    contains(o) {
      for (let x = o; x; x = x.parentNode) if (x === n) return true;
      return false;
    },
  };
  return n;
};
const fire = (type, target, relatedTarget = null) => {
  const e = { target, relatedTarget, dataTransfer: { types: ["Files"], files: [] }, preventDefault() {} };
  for (const l of listeners) if (l.type === type) l.fn(e);
};

let registerDropSurface;
beforeAll(async () => {
  globalThis.window = {};
  globalThis.document = { addEventListener: (type, fn) => listeners.push({ type, fn }) };
  ({ registerDropSurface } = await import("./dropSurfaces.js"));
});

const root = node();
const sidebar = node(root);
const paneA = node(root);
const paneB = node(root);
const txB = node(paneB);

const unregisters = [];
function surface(pane, focused = false) {
  const s = { editorEl: node(pane), dropped: [], active: false };
  unregisters.push(registerDropSurface({
    editor: () => s.editorEl,
    focused: () => focused,
    drop: (entries) => s.dropped.push(...entries),
    dropFiles: () => {},
    setDragActive: (a) => { s.active = a; },
  }));
  return s;
}
afterEach(() => unregisters.splice(0).forEach((u) => u()));

const entries = [{ path: "/tmp/a.png", isDir: false }];

describe("dropSurfaces", () => {
  it("routes a drop to the pane it lands on, not the newest composer", () => {
    const b = surface(paneB);
    const a = surface(paneA, true);
    fire("drop", txB);
    window.__eosNativeDrop(entries);
    expect(b.dropped).toEqual(entries);
    expect(a.dropped).toEqual([]);
  });

  it("sends a drop outside every pane to the focused composer", () => {
    const a = surface(paneA, true);
    const b = surface(paneB);
    fire("drop", sidebar);
    window.__eosNativeDrop(entries);
    expect(a.dropped).toEqual(entries);
    expect(b.dropped).toEqual([]);
  });

  it("highlights the surface under the drag and clears on leave", () => {
    const a = surface(paneA, true);
    const b = surface(paneB);
    fire("dragover", txB);
    expect([a.active, b.active]).toEqual([false, true]);
    fire("dragover", paneA);
    expect([a.active, b.active]).toEqual([true, false]);
    fire("dragleave", paneA);
    expect([a.active, b.active]).toEqual([false, false]);
  });
});
