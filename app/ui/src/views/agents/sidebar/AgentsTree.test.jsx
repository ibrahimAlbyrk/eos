import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UiProvider } from "../../../state/ui.jsx";
import { AgentsTree } from "./AgentsTree.jsx";

// Regression: before the first /workers fetch resolves (loaded=false) an empty
// list must render as loading, not as the definitive "No agents yet" — a
// hanging or failed initial fetch used to read as zero agents existing.
describe("AgentsTree empty state", () => {
  it("shows loading, not 'No agents yet', while the workers list is unloaded", () => {
    const html = renderToStaticMarkup(<AgentsTree roots={[]} loaded={false} />);
    expect(html).not.toContain("No agents yet");
    expect(html).toContain("Loading agents");
  });

  it("shows 'No agents yet' only once loaded with a truly empty list", () => {
    const html = renderToStaticMarkup(<AgentsTree roots={[]} loaded={true} />);
    expect(html).toContain("No agents yet");
  });
});

// The ui providers seed initial state from localStorage in render-time useState
// initializers; the node test env has none, so stub it.
function stubStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

const NOW = Date.now();
const agent = (id, extra = {}) => ({
  id, name: `${id} Orchestrator`, is_orchestrator: 1, state: "IDLE",
  started_at: NOW - 2 * 3_600_000, cwd: "/p/app", children: [], ...extra,
});
const render = (roots, props = {}) =>
  renderToStaticMarkup(
    <UiProvider>
      <AgentsTree roots={roots} loaded={true} {...props} />
    </UiProvider>,
  );

describe("AgentsTree rows", () => {
  beforeEach(() => { globalThis.localStorage = stubStorage(); });
  afterEach(() => { delete globalThis.localStorage; });

  it("shows an idle row's age instead of 'idle', without the Orchestrator suffix", () => {
    const html = render([agent("Alpha")]);
    expect(html).toContain(">2h<");
    expect(html).not.toContain(">idle<");
    expect(html).not.toContain("Alpha Orchestrator");
  });

  it("shows a spinner for a running row", () => {
    expect(render([agent("Run", { state: "WORKING" })])).toContain('aria-label="running"');
  });

  it("shows Input for an open ask_user question (from the row) or a pending permission", () => {
    expect(render([agent("Ask", { awaiting_question: true })])).toContain(">Input<");
    expect(render([agent("Perm")], { waitingIds: new Set(["Perm"]) })).toContain(">Input<");
    expect(render([agent("Calm")])).not.toContain(">Input<");
  });

  it("surfaces a sub-agent's question on its folded parent", () => {
    globalThis.localStorage.setItem("cm:collapsedNodes", JSON.stringify(["Lead"]));
    const parent = agent("Lead", { children: [agent("Sub", { is_orchestrator: 0, awaiting_question: true })] });
    const html = render([parent]);
    const leadRow = html.slice(html.indexOf(">Lead<"), html.indexOf(">Sub<"));
    expect(leadRow).toContain(">Input<");
  });

  it("keeps rows active in the last 4h past the first three, folding older ones behind 'Show N more'", () => {
    const HOUR = 3_600_000;
    const roots = [["A", 0], ["B", 1], ["C", 2], ["D", 3 * HOUR], ["E", 5 * HOUR], ["F", 48 * HOUR]]
      .map(([id, ago]) => agent(id, { turn_started_at: NOW - ago }));
    roots.push(agent("Busy", { state: "WORKING", turn_started_at: NOW - 24 * HOUR }));
    const html = render(roots);
    expect(html).toContain(">D<");
    expect(html).toContain(">Busy<");
    expect(html).not.toContain(">E<");
    expect(html).toContain("Show 2 more");
  });

  it("caps the recent window at eight rows", () => {
    const roots = Array.from({ length: 10 }, (_, i) => agent(`R${i}`, { turn_started_at: NOW - i * 60_000 }));
    const html = render(roots);
    expect(html).toContain(">R7<");
    expect(html).not.toContain(">R8<");
    expect(html).toContain("Show 2 more");
  });

  it("lists no-folder sessions under Recents, after the projects", () => {
    const html = render([agent("Proj"), agent("Loose", { scratch: true, cwd: null })]);
    expect(html).toContain("Recents");
    expect(html).not.toContain("No folder");
    expect(html.indexOf(">Proj<")).toBeLessThan(html.indexOf("Recents"));
    expect(html.indexOf("Recents")).toBeLessThan(html.indexOf(">Loose<"));
  });
});
