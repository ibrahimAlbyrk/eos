import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UiProvider } from "../../../state/ui.jsx";
import { PaneScopeContext } from "../../../state/paneScope.js";
import { registerPanel } from "../../../lib/panelRegistry.js";
import { PanelShell } from "./PanelShell.jsx";

// The ui providers seed their initial state from localStorage in render-time
// useState initializers; the node test env has none, so give them a stub. (No
// effects run under renderToStaticMarkup, so this is the only global needed.)
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// A registry type local to this test file (the module registry is per-file in
// vitest, so this never leaks into other suites).
registerPanel({ type: "shelltest", label: "Shelly", close: () => {} });

function renderShell(props = {}, children = null) {
  return renderToStaticMarkup(
    <UiProvider>
      <PaneScopeContext.Provider value="leaf-a">
        <PanelShell type="shelltest" {...props}>{children}</PanelShell>
      </PaneScopeContext.Provider>
    </UiProvider>,
  );
}

describe("PanelShell", () => {
  it("defaults the title to the registry label with the standard typography", () => {
    const html = renderShell();
    expect(html).toContain("panel-shell__label");
    expect(html).toContain("Shelly");
  });

  it("renders a node title as-is (no label wrapper)", () => {
    const html = renderShell({ title: <span className="my-crumb">repo · main</span> });
    expect(html).toContain("my-crumb");
    expect(html).not.toContain("panel-shell__label");
  });

  it("renders the shared fullscreen toggle and close button for every panel", () => {
    const html = renderShell();
    expect(html).toContain("Fullscreen Shelly panel");
    expect(html).toContain('title="Close"');
  });

  it("puts viewer actions in the header and the body in the island", () => {
    const html = renderShell({ actions: <button className="my-action">act</button> }, <div className="my-body" />);
    const head = html.slice(html.indexOf("panel-shell__head"), html.indexOf("my-body"));
    expect(head).toContain("my-action");
    expect(html).toContain("panel-shell--shelltest");
  });
});
