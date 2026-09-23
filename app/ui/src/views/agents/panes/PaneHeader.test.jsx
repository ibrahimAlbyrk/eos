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

  it("marks top-row split panes with --toprow, never the default (N=1) header", () => {
    expect(renderHeader({ canClose: false })).not.toContain("pane-head--toprow");
    expect(renderHeader({ canClose: true, split: true, topRow: true })).toContain("pane-head--toprow");
  });

  it("renders Environment, Split and Open side panel in the single header", () => {
    const html = renderHeader({ canClose: false });
    expect(html).toContain("Environment &amp; changes");
    expect(html).toContain("Split layout");
    expect(html).toContain("Open side panel");
    // The old per-panel toggle buttons are gone.
    expect(html).not.toContain("Toggle terminal panel");
  });

  it("shows the plan chip with done/total only when the agent has a task list", () => {
    expect(renderHeader({ canClose: false })).not.toContain("plan-chip");
    const tasks = JSON.stringify([
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "pending" },
    ]);
    const html = renderHeader({ canClose: false, worker: { ...alpha, tasks } });
    expect(html).toContain("Plan: 1 of 3 done");
    expect(html).toContain("1/3");
  });

  it("split panes carry Environment + Open side panel but not the Split menu button", () => {
    const html = renderHeader({ canClose: true, split: true, topRow: true });
    expect(html).toContain("Environment &amp; changes");
    expect(html).toContain("Open side panel");
    expect(html).not.toContain("Split layout");
  });
});
