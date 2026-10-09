import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UiProvider } from "../state/ui.jsx";
import { parseMarkup, walkMarkup } from "../../../../contracts/src/genui/markup.ts";
import restaurants from "../../../../contracts/src/__tests__/fixtures/genui/restaurants.json";
import trip from "../../../../contracts/src/__tests__/fixtures/genui/trip.json";
import tests from "../../../../contracts/src/__tests__/fixtures/genui/tests.json";
import learn from "../../../../contracts/src/__tests__/fixtures/genui/learn.json";
import app from "../../../../contracts/src/__tests__/fixtures/genui/app.json";
import { ViewBlock, ViewSurface } from "./ViewBlock.jsx";
import { GenuiHostContext } from "./runtime/host.jsx";
import { KIT } from "./kit/index.js";

// The scenario fixtures through the REAL kit: whatever groups exist render
// without throwing and without falling back to the summary.

vi.mock("../lib/markdown.js", async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, renderMarkdown: mod.markdownToHtml };
});

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const VIEW = "v_fixtureabcde";
const conv = { workerId: "w1", cwd: "/Users/me/p", send: async () => ({ ok: true }), superseded: new Map(), fixedBelow: new Set() };
const render = (el) => renderToStaticMarkup(
  <UiProvider><GenuiHostContext.Provider value={conv}>{el}</GenuiHostContext.Provider></UiProvider>,
);

const tagsOf = (ui) => {
  const out = new Set();
  walkMarkup(parseMarkup(ui).nodes, (el) => out.add(el.name));
  return [...out];
};

describe.each([
  ["restaurants", restaurants],
  ["trip", trip],
  ["tests", tests],
  ["learn", learn],
])("fixture %s through the kit", (_name, spec) => {
  const tags = tagsOf(spec.ui);
  const missing = tags.filter((t) => !KIT[t]);

  it("renders the view chrome without throwing", () => {
    const html = render(<ViewSurface viewId={VIEW} spec={spec} ts={Date.now()} />);
    const anyKnown = tags.some((t) => KIT[t]);
    if (anyKnown) {
      expect(html).toContain('class="gv-view"');
      expect(html).toContain(`data-genui-view="${VIEW}"`);
    } else {
      expect(html).toContain("gv-fallback");
    }
  });

  it.skipIf(missing.length > 0)("every tag it uses is in the kit", () => {
    expect(missing).toEqual([]);
    const html = render(<ViewSurface viewId={VIEW} spec={spec} />);
    expect(html).not.toContain("gv-fallback");
    expect(html).not.toContain("Couldn&#x27;t show this part");
  });
});

describe("present_app fixture", () => {
  it("renders through AppFrame, linked back by its view id", () => {
    const tool = {
      id: "toolu_app", name: "mcp__orchestrator__present_app", input: app,
      result: { isError: false, text: `view ${VIEW} rendered · app` }, running: false, done: true, ts: 1,
    };
    const html = render(<ViewBlock block={{ kind: "view", tool, ts: 1 }} />);
    expect(html).toContain("APP · SANDBOXED");
    expect(html).toContain("V60 Brew Timer");
    expect(html).toContain(`data-genui-view="${VIEW}"`);
  });
});
