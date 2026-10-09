import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UiProvider } from "../state/ui.jsx";
import restaurants from "../../../../contracts/src/__tests__/fixtures/genui/restaurants.json";
import trip from "../../../../contracts/src/__tests__/fixtures/genui/trip.json";
import tests from "../../../../contracts/src/__tests__/fixtures/genui/tests.json";
import learn from "../../../../contracts/src/__tests__/fixtures/genui/learn.json";
import { ViewBlock, ViewSurface, viewMeta } from "./ViewBlock.jsx";
import { GenuiHostContext } from "./runtime/host.jsx";
import { genuiIndex } from "./runtime/conversation.js";
import { applyGenuiDelta, _reset as resetStreams } from "./streamStore.js";

// DOMPurify needs a DOM; the node test env has none, so render unsanitized.
vi.mock("../lib/markdown.js", async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, renderMarkdown: mod.markdownToHtml };
});

// A stub kit over the real runtime: every catalog component renders a marker,
// and the lenses that read data print what the runtime hands them. This pins the
// renderer + runtime contract independently of the real kit's markup.
vi.mock("./kit/index.js", async () => {
  const { COMPONENT_NAMES } = await import("../../../../contracts/src/genui/catalog.ts");
  const { useView, ItemScope } = await import("./runtime/ViewContext.jsx");
  const counted = new Set(["Carousel", "Table", "Map", "Timeline", "Meter", "Checklist", "KeyValue"]);
  const make = (name) => function Stub({ attrs, node, children }) {
    const view = useView();
    if (counted.has(name) && attrs.of) {
      return <div className={`stub stub-${name}`} data-count={view.collection(attrs.of, attrs).length} />;
    }
    if (name === "List") {
      return (
        <div className="stub stub-List">
          {view.collection(attrs.of, attrs).map((it, i) => (
            <div key={i} className="stub-row" data-title={view.template(attrs.title, it)}>
              <ItemScope item={it}>{children}</ItemScope>
            </div>
          ))}
        </div>
      );
    }
    if (name === "Code") return <pre className="stub stub-Code">{attrs.value ? view.template(attrs.value) : children}</pre>;
    if (name === "Value") return <span className="stub stub-Value">{String(view.evalExpr(attrs.expr))}</span>;
    if (name === "Hero") {
      const it = view.allItems(attrs.of).find((x) => x.id === attrs.pick);
      return <div className="stub stub-Hero" data-meta={view.template(attrs.meta, it)}>{children}</div>;
    }
    if (name === "Tabs") {
      const labels = [].concat(children ?? []).map((c) => c?.props?.node?.attrs?.label ?? "");
      return <div className="stub stub-Tabs" data-labels={labels.join("|")}>{children}</div>;
    }
    return <div className={`stub stub-${name}`} data-line={node.pos.line}>{children}</div>;
  };
  const KIT = Object.fromEntries(COMPONENT_NAMES.map((n) => [n, make(n)]));
  return { KIT, kitHas: (n) => n in KIT };
});

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const VIEW = "v_7Hq2abcdefgh";
const WORKER = "w-orch";
const conv = (extra = {}) => ({ workerId: WORKER, cwd: "/Users/me/proj", send: vi.fn(async () => ({ ok: true })), superseded: new Map(), fixedBelow: new Set(), ...extra });
const render = (el, c = conv()) => renderToStaticMarkup(
  <UiProvider><GenuiHostContext.Provider value={c}>{el}</GenuiHostContext.Provider></UiProvider>,
);
const tool = (input, over = {}) => ({
  id: "toolu_1", name: "mcp__orchestrator__present", verb: "read", input,
  result: { text: `view ${VIEW} rendered · 6 places`, isError: false }, running: false, done: true, ts: 1_760_000_000_000, ...over,
});
const count = (html, cls) => (html.match(new RegExp(`class="stub stub-${cls}"`, "g")) ?? []).length;
const dataCount = (html, cls) => Number(new RegExp(`stub-${cls}" data-count="(\\d+)"`).exec(html)?.[1]);

describe("ViewSurface renders the scenario fixtures through the kit", () => {
  beforeEach(() => resetStreams());

  it("restaurants: header, filtered lenses, hero template, sources, actions", () => {
    const html = render(<ViewSurface viewId={VIEW} spec={restaurants} ts={tool({}).ts} />);
    expect(html).toContain('class="gv-view"');
    expect(html).toContain("Kadıköy&#x27;de bu akşam");
    expect(html).toContain("6 places");
    expect(html).toContain(`data-genui-view="${VIEW}"`);
    expect(html).toContain('aria-label="Open in side panel"');
    expect(html).toContain("--gv-accent:#67affd");
    // "Şu an açık" starts on: Sofra Moda (closed) leaves every lens.
    expect(dataCount(html, "Map")).toBe(5);
    expect(dataCount(html, "Table")).toBe(5);
    expect(dataCount(html, "Carousel")).toBe(4); // skip="moda"
    expect(html).toContain('data-meta="Meyhane · Deniz ürünü · Moda"');
    expect(html).toContain("<strong>masa ayırtmak</strong>");
    for (const c of ["Filters", "Section", "Sources", "Actions"]) expect(count(html, c)).toBe(1);
    expect(html).not.toContain("gv-fallback");
  });

  it("trip: a Segmented default drives where=day == state.day; Value sums the budget", () => {
    const html = render(<ViewSurface viewId={VIEW} spec={trip} />);
    const saturday = trip.data.stops.filter((s) => s.day === "Cumartesi").length;
    expect(dataCount(html, "Timeline")).toBe(saturday);
    expect(dataCount(html, "Map")).toBe(saturday);
    const total = trip.data.budget.reduce((a, b) => a + b.amount, 0);
    expect(html).toContain(`<span class="stub stub-Value">${total}</span>`);
    expect(count(html, "Callout")).toBe(1);
  });

  it("tests: tab labels reach the Tabs container; List rows template their children", () => {
    const html = render(<ViewSurface viewId={VIEW} spec={tests} />);
    expect(html).toContain('data-labels="Failures · 5|Slowest|Flaky · 2"');
    expect(count(html, "Stat")).toBe(4);
    expect((html.match(/class="stub-row"/g) ?? []).length).toBe(tests.data.failures.length + tests.data.flaky.length);
    // <Code value="{trace}"> inside a List row reads that row's item.
    expect(html).toContain("ECONNREFUSED /tmp/eos-test-81f2/daemon.sock");
  });

  it("learn: steppers, compare table, quiz", () => {
    const html = render(<ViewSurface viewId={VIEW} spec={learn} />);
    expect(count(html, "Steps")).toBe(2);
    expect(dataCount(html, "Table")).toBe(learn.data.compare.length);
    expect(count(html, "Choice")).toBe(1);
  });

  it("an unknown tag is skipped; nothing renderable falls back to the summary", () => {
    const mixed = render(<ViewSurface viewId={VIEW} spec={{ ...restaurants, ui: '<Sparkle/><Text>still here</Text>' }} />);
    expect(mixed).toContain("still here");
    expect(mixed).not.toContain("Sparkle");
    // Nothing goes missing silently: the view says part of it needs a newer build.
    expect(mixed).toContain("Part of this view needs a newer Eos");
    expect(mixed).toContain("Show summary");
    const nested = render(<ViewSurface viewId={VIEW} spec={{ ...restaurants, ui: '<Section title="x"><Weather/><Text>ok</Text></Section>' }} />);
    expect(nested).toContain("Part of this view needs a newer Eos");
    expect(render(<ViewSurface viewId={VIEW} spec={restaurants} />)).not.toContain("needs a newer Eos");
    const none = render(<ViewSurface viewId={VIEW} spec={{ ...restaurants, ui: "<Sparkle/><Glitter>x</Glitter>" }} />);
    expect(none).toContain("This view couldn&#x27;t be displayed · showing its summary");
    expect(none).toContain("En iyi eşleşme: Moda Kıyı");
    expect(none).not.toContain("Show spec");
    expect(none).not.toContain("<pre");
  });

  it("when= hides an element while its expression is false", () => {
    const spec = { title: "t", summary: "s", data: { n: 0 }, ui: '<Text when="data.n > 0">shown</Text><Text when="data.n == 0">zero</Text>' };
    const html = render(<ViewSurface viewId={VIEW} spec={spec} />);
    expect(html).toContain("zero");
    expect(html).not.toContain("shown");
  });
});

describe("ViewBlock states", () => {
  beforeEach(() => resetStreams());

  it("complete: the finished call renders the view", () => {
    const html = render(<ViewBlock block={{ kind: "view", tool: tool(restaurants), ts: 1 }} />);
    expect(html).toContain('class="gv-view"');
    expect(html).toContain(`data-genui-view="${VIEW}"`);
  });

  it("validating: the input is in but no result yet — rendered, not yet expandable", () => {
    const html = render(<ViewBlock block={{ kind: "view", tool: tool(restaurants, { result: null, running: true, done: false }), ts: 1 }} />);
    expect(html).toContain('class="gv-view"');
    expect(html).not.toContain("data-genui-view");
    expect(html).not.toContain("Open in side panel");
  });

  it("failed: one line with the first problem, or “fixed below” once a later view worked", () => {
    const failed = tool(restaurants, {
      result: { isError: true, text: "1 problem — nothing rendered\n· data.places[3].rating: 6.2 is outside 0–5\nfix and call present again" },
    });
    const html = render(<ViewBlock block={{ kind: "view", tool: failed, ts: 1 }} />);
    expect(html).toContain("Couldn&#x27;t render “Kadıköy&#x27;de bu akşam” — data.places[3].rating: 6.2 is outside 0–5");
    expect(html).not.toContain('class="gv-view"');
    const fixed = render(<ViewBlock block={{ kind: "view", tool: failed, ts: 1 }} />, conv({ fixedBelow: new Set(["toolu_1"]) }));
    expect(fixed).toContain("— fixed below");
  });

  it("interrupted: a call that ended without a result", () => {
    const html = render(<ViewBlock block={{ kind: "view", tool: tool(restaurants, { result: null, running: false }), ts: 1 }} />);
    expect(html).toContain("stopped before it was shown");
  });

  it("visual answers off: a quiet line", () => {
    const html = render(<ViewBlock block={{ kind: "view", tool: tool(restaurants, { result: { isError: false, text: "Visual answers are off — answer in text" } }), ts: 1 }} />);
    expect(html).toContain("Visual answers are off — answered in text");
  });

  it("apps off: a quiet line, and the app never runs", () => {
    const app = { title: "Timer", html: "<p>x</p>", summary: "s" };
    const html = render(<ViewBlock block={{ kind: "view", tool: tool(app, { name: "mcp__orchestrator__present_app", result: { isError: false, text: "Apps are turned off in Settings — use present or plain text" } }), ts: 1 }} />);
    expect(html).toContain("Apps are off — answered without one");
    expect(html).not.toContain("<iframe");
  });

  it("an app whose call hasn't been accepted yet never runs: pending until the result names the view", () => {
    const app = { title: "Timer", html: "<script>window.eos.openLink('https://x.example')</script>", summary: "s" };
    const inflight = tool(app, { name: "mcp__orchestrator__present_app", result: null, running: true, done: false });
    const html = render(<ViewBlock block={{ kind: "view", tool: inflight, ts: 1 }} />);
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("openLink");
    const accepted = render(<ViewBlock block={{ kind: "view", tool: tool(app, { name: "mcp__orchestrator__present_app", result: { isError: false, text: `view ${VIEW} rendered · app` } }), ts: 1 }} />);
    expect(accepted).toContain("<iframe");
  });

  it("a plain result that names no view rendered nothing: a failed line, not the input", () => {
    const html = render(<ViewBlock block={{ kind: "view", tool: tool(restaurants, { result: { isError: false, text: "present: the daemon answered without a view id — nothing rendered" } }), ts: 1 }} />);
    expect(html).toContain("gv-failed");
    expect(html).not.toContain('class="gv-view"');
  });

  it("superseded: a stub naming the earlier version", () => {
    const html = render(
      <ViewBlock block={{ kind: "view", tool: tool(restaurants), ts: 1 }} />,
      conv({ superseded: new Map([[VIEW, { by: "v_newnewnewnew", title: "x" }]]) }),
    );
    expect(html).toContain("gv-stub");
    expect(html).toContain("earlier version · updated below");
    expect(html).not.toContain('class="gv-view"');
  });

  it("streaming: a skeleton before the title, then the settled part of a growing input", () => {
    const full = JSON.stringify(restaurants);
    const block = { kind: "view", live: true, ts: 1, tool: { id: "toolu_s", name: "mcp__orchestrator__present", input: {}, result: null, running: true, done: false, ts: 1 } };
    applyGenuiDelta({ workerId: WORKER, callId: "toolu_s", name: block.tool.name, phase: "start", text: "" });
    expect(render(<ViewBlock block={block} />)).toContain("Composing a view…");
    let sent = 0;
    let lastStubs = 0;
    let sawTitle = false;
    for (const cut of [8, 40, 400, 1500, 3000, 4200, full.indexOf('"ui"') + 120, full.indexOf('"ui"') + 400, full.indexOf('"ui"') + 900, full.length]) {
      applyGenuiDelta({ workerId: WORKER, callId: "toolu_s", name: block.tool.name, phase: "append", text: full.slice(sent, cut) });
      sent = cut;
      const html = render(<ViewBlock block={block} />);
      if (html.includes("Kadıköy&#x27;de bu akşam")) sawTitle = true;
      const stubs = (html.match(/class="stub /g) ?? []).length;
      expect(stubs).toBeGreaterThanOrEqual(lastStubs);
      lastStubs = stubs;
    }
    expect(sawTitle).toBe(true);
    // The whole ui settled, still marked as streaming until the call lands.
    const done = render(<ViewBlock block={block} />);
    expect(dataCount(done, "Table")).toBe(5);
    expect(done).toContain('aria-busy="true"');
  });

  it("a lane without deltas: skeleton while the call runs, then the full view", () => {
    const running = { kind: "view", ts: 1, tool: tool({}, { result: null, running: true, done: false }) };
    expect(render(<ViewBlock block={running} />)).toContain("Composing a view…");
    expect(render(<ViewBlock block={{ kind: "view", tool: tool(trip), ts: 1 }} />)).toContain("stub-Timeline");
  });
});

describe("conversation-wide facts", () => {
  it("a later view with replaces supersedes the earlier one; a refused call before a success is fixed below", () => {
    const blocks = [
      { kind: "view", tool: tool(restaurants) },
      { kind: "assistant", text: "x" },
      { kind: "view", tool: { ...tool(restaurants), id: "toolu_bad", result: { isError: true, text: "1 problem" } } },
      { kind: "view", tool: { ...tool({ ...restaurants, replaces: VIEW }), id: "toolu_2", result: { isError: false, text: "view v_secondsecond rendered" } } },
    ];
    const idx = genuiIndex(blocks);
    expect(idx.superseded.get(VIEW)).toEqual({ by: "v_secondsecond", title: restaurants.title });
    expect([...idx.fixedBelow]).toEqual(["toolu_bad"]);
    // A replacement that hasn't succeeded supersedes nothing.
    expect(genuiIndex(blocks.slice(0, 3)).superseded.size).toBe(0);
  });

  it("the header meta counts the main plural collection", () => {
    expect(viewMeta(restaurants, null)).toBe("6 places");
    expect(viewMeta(learn, null)).toBe("");
    expect(viewMeta(tests, null)).toBe("5 failures");
  });
});
