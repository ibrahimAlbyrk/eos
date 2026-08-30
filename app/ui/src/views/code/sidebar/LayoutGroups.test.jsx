import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UiProvider } from "../../../state/ui.jsx";
import { LayoutGroups } from "./LayoutGroups.jsx";
import { addGroup, _resetLayoutGroups } from "../../../state/layoutGroupsStore.js";

// The ui providers seed initial state from localStorage in render-time useState
// initializers; the node test env has none, so stub it (no effects run under
// renderToStaticMarkup, so this is the only global needed).
function stubStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

beforeEach(() => {
  _resetLayoutGroups();
  globalThis.localStorage = stubStorage();
});
afterEach(() => {
  delete globalThis.localStorage;
});

const render = () =>
  renderToStaticMarkup(
    <UiProvider>
      <LayoutGroups aliveIds={new Set()} />
    </UiProvider>,
  );

describe("LayoutGroups sidebar section", () => {
  it("always renders the Layouts header with a save affordance", () => {
    const html = render();
    expect(html).toContain("Layouts");
    expect(html).toContain("Save current layout as group");
  });

  it("renders a row (name + leaf count) for each saved group", () => {
    addGroup("My Split", { t: "split", id: "S", dir: "row", ratio: 0.5, a: { t: "leaf", id: "L1", agentId: "a" }, b: { t: "leaf", id: "L2", agentId: "b" } });
    const html = render();
    expect(html).toContain("My Split");
    expect(html).toContain(">2<"); // leafCount rendered in the row's status slot
  });
});
