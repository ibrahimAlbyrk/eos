import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UiProvider } from "../../../state/ui.jsx";
import { PaneScopeContext } from "../../../state/paneScope.js";
import { ContextChip } from "./ContextChip.jsx";

// UiProvider seeds state from localStorage in render-time initializers.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// No model in the catalog → the 200k fallback window.
const render = (worker) =>
  renderToStaticMarkup(
    <UiProvider>
      <PaneScopeContext.Provider value="leaf-a">
        <ContextChip worker={worker} />
      </PaneScopeContext.Provider>
    </UiProvider>,
  );

describe("ContextChip", () => {
  it("shows the context fill as a meter + percent", () => {
    const html = render({ id: "a", last_context_tokens: 76_000 });
    expect(html).toContain("38%");
    expect(html).toContain("width:38%");
    expect(html).not.toContain("is-warn");
  });

  it("tints warn at ≥80%", () => {
    const html = render({ id: "a", last_context_tokens: 170_000 });
    expect(html).toContain("85%");
    expect(html).toContain("ctx-chip is-warn");
  });
});
