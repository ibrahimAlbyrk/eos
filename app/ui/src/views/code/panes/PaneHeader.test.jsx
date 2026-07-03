import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UiProvider } from "../../../state/ui.jsx";
import { PaneScopeContext } from "../../../state/paneScope.js";
import { PaneHeader } from "./PaneHeader.jsx";

// The ui providers seed their initial state from localStorage in render-time
// useState initializers; the node test env has none, so give them a stub. (No
// effects run under renderToStaticMarkup, so this is the only global needed.)
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const alpha = { id: "a", name: "agent-alpha", is_orchestrator: 1, parent_id: null, cwd: "/Users/me/proj", worktree_from: null, state: "IDLE" };
const beta = { id: "b", name: "agent-beta", is_orchestrator: 1, parent_id: null, cwd: "/Users/me/proj", worktree_from: null, state: "IDLE" };
const live = { workers: [alpha, beta], renameAgent: () => {}, pendingPermissions: [] };

function renderHeader(props) {
  return renderToStaticMarkup(
    <UiProvider>
      <PaneScopeContext.Provider value="leaf-a">
        <PaneHeader worker={alpha} live={live} attention={false} needsInput={false} onClose={() => {}} {...props} />
      </PaneScopeContext.Provider>
    </UiProvider>,
  );
}

describe("PaneHeader", () => {
  it("breadcrumb reflects the pane's OWN agent, not the focused selection", () => {
    // The focused/selected agent is beta; the pane's own agent is alpha.
    store.set("cm:selectedId", "b");
    const html = renderHeader({ canClose: true });
    expect(html).toContain("agent-alpha");
    expect(html).not.toContain("agent-beta");
  });

  it("hides the close button when canClose is false", () => {
    expect(renderHeader({ canClose: false })).not.toContain("Close pane");
    expect(renderHeader({ canClose: true })).toContain("Close pane");
  });
});
