import { describe, it, expect, vi, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UiProvider } from "../state/ui.jsx";
import { buildBlocks } from "../lib/messageParser.js";
import { foldTurns } from "../lib/turnFold.js";
import restaurants from "../../../../contracts/src/__tests__/fixtures/genui/restaurants.json";
import trip from "../../../../contracts/src/__tests__/fixtures/genui/trip.json";
import tests from "../../../../contracts/src/__tests__/fixtures/genui/tests.json";
import learn from "../../../../contracts/src/__tests__/fixtures/genui/learn.json";
import app from "../../../../contracts/src/__tests__/fixtures/genui/app.json";
import { ViewBlock } from "./ViewBlock.jsx";
import { GenuiHostContext } from "./runtime/host.jsx";
import { createViewRuntime, scanMarkup } from "./runtime/runtime.js";
import { setViewState, _reset as resetViewState } from "./runtime/viewStateStore.js";
import { applyGenuiDelta, _reset as resetStreams } from "./streamStore.js";
import { parseMarkup } from "../../../../contracts/src/genui/markup.ts";
import { ViewReplyChip } from "../views/agents/messages/MessageUser.jsx";

// The five scenario boards end to end: each contracts fixture goes in as the
// transcript rows a present / present_app call leaves (tool_call + its result),
// through messageParser into a view block, and out of the REAL ViewBlock, kit
// and AppFrame. Each test asserts the parts of its board a user would see.

// DOMPurify needs a DOM; the node test env has none, so render unsanitized.
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

afterEach(() => {
  resetViewState();
  resetStreams();
});

const WORKER = "w-orch";
const conv = { workerId: WORKER, cwd: "/Users/me/p", project: "/Users/me/p", send: async () => ({ ok: true }), superseded: new Map(), fixedBelow: new Set() };

let rowId = 0;
const ev = (type, payload, ts) => ({ id: ++rowId, type, ts, payload: JSON.stringify(payload) });

// The rows a finished present call leaves in a worker's event log.
function transcript(name, input, viewId, callId = "toolu_e2e") {
  return [
    ev("user_message", { text: "show me" }, 1),
    ev("agent_event", { type: "message", role: "assistant", blocks: [{ type: "tool_call", callId, name, input }] }, 2),
    ev("agent_event", { type: "message", role: "tool", blocks: [{ type: "tool_result", callId, content: `view ${viewId} rendered`, isError: false }] }, 3),
    ev("agent_event", { type: "message", role: "assistant", blocks: [{ type: "text", text: "Here it is." }] }, 4),
    ev("agent_event", { type: "turn", phase: "completed" }, 5),
  ];
}

function viewBlock(name, input, viewId) {
  const blocks = buildBlocks(transcript(name, input, viewId));
  const view = blocks.find((b) => b.kind === "view");
  expect(view, "messageParser makes a view block").toBeTruthy();
  expect(blocks.some((b) => b.kind === "tool" || b.kind === "toolGroup"), "no tool chrome").toBe(false);
  // A finished turn folds its work, never the view.
  const { items } = foldTurns(blocks, (b, i) => `${b.kind}-${i}`);
  expect(items.some((it) => it.kind !== "fold" && it.block === view), "the view stays pinned when the turn folds").toBe(true);
  return view;
}

const render = (block) => renderToStaticMarkup(
  <UiProvider><GenuiHostContext.Provider value={conv}><ViewBlock block={block} /></GenuiHostContext.Provider></UiProvider>,
);

const count = (html, re) => (html.match(re) ?? []).length;

// Every image goes through the daemon's media proxy (or logo.dev, loaded
// directly as its terms require) — never straight from the web.
function expectProxiedImages(html) {
  for (const [, src] of html.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)) {
    expect(src.startsWith("http://127.0.0.1:7400/api/genui/media/") || src.startsWith("https://img.logo.dev/") || src.startsWith("data:"), src).toBe(true);
  }
}

function expectNoBrokenParts(html) {
  expect(html).not.toContain("gv-fallback");
  expect(html).not.toContain("Couldn&#x27;t show this part");
}

describe("Main board — restaurants", () => {
  const VIEW = "v_restaurants1";
  const html = () => render(viewBlock("mcp__orchestrator__present", restaurants, VIEW));

  it("renders the view chrome: tone, icon tile, title, count meta, expand", () => {
    const h = html();
    expect(h).toContain('class="gv-view"');
    expect(h).toContain(`data-genui-view="${VIEW}"`);
    expect(h).toContain("--gv-accent:#67affd");
    expect(h).toContain(`<div class="gv-title">${restaurants.title.replace("'", "&#x27;")}</div>`);
    expect(h).toMatch(/<div class="gv-meta">6 places · /);
    expect(h).toContain('aria-label="Open in side panel"');
    expectNoBrokenParts(h);
    expectProxiedImages(h);
  });

  it("filters: six chips, the first on, and the count they leave", () => {
    const h = html();
    expect(count(h, /class="gv-fchip[ "]/g)).toBe(6);
    expect(h).toMatch(/class="gv-fchip is-on" aria-pressed="true" title="open"/);
    expect(h).toContain('<span class="gv-filters__count" aria-live="polite">5 of 6</span>');
  });

  it("map: a static map with numbered pins for the open places, and its attribution", () => {
    const h = html();
    expect(h).toContain('aria-label="Map of 5 places"');
    expect(count(h, /class="gv-pin gv-pin--index"/g)).toBe(5);
    expect(h).toContain('aria-label="1. Moda Kıyı"');
    expect(h).toContain('© OpenFreeMap · © OpenMapTiles · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors');
  });

  it("hero: the pick, its badge, templated meta, the reason and its actions", () => {
    const h = html();
    expect(h).toContain('<article class="gv-hero">');
    expect(h).toContain('<div class="gv-hero-name">Moda Kıyı</div>');
    expect(h).toContain("En iyi eşleşme");
    expect(h).toContain('<div class="gv-hero-meta">Meyhane · Deniz ürünü · Moda</div>');
    expect(h).toContain("<strong>masa ayırtmak</strong>");
    expect(h).toMatch(/class="gv-btn gv-btn-primary" data-action="book"/);
    expect(h).toContain('data-action="route"');
    expect(h).toContain('data-action="menu"');
  });

  it("carousel: the other open places in a section, the hero's pick skipped", () => {
    const h = html();
    expect(h).toContain('<span class="gv-section-title">Diğer seçenekler</span>');
    const carousel = h.slice(h.indexOf('class="gv-carousel '), h.indexOf('class="gv-table"'));
    expect(carousel).toContain('aria-label="4 items"');
    expect(count(carousel, /class="gv-carousel-slide"/g)).toBe(4);
    expect(carousel).not.toContain(">Moda Kıyı<");
    expect(carousel).toContain('<span class="gv-card-title">Lâl Balık</span>');
  });

  it("compare table: the named columns, numbered rows for what the chips leave", () => {
    const h = html();
    const table = h.slice(h.indexOf('class="gv-table"'), h.indexOf('class="gv-sources'));
    for (const col of ["Mekan", "Puan", "Fiyat", "Mesafe", "Kapanış"]) expect(table).toContain(col);
    expect(count(table, /<th scope="row"/g)).toBe(5);
    expect(table).toContain('<span class="gv-table__num" aria-hidden="true">1</span>Moda Kıyı');
  });

  it("sources and the view's own actions", () => {
    const h = html();
    expect(h).toMatch(/<span class="gv-src-summary">4 sources · as of /);
    for (const id of ["seaOnly", "youBook", "veg"]) expect(h).toContain(`data-action="${id}"`);
  });
});

describe("Trip board", () => {
  const VIEW = "v_tripizmir123";
  const html = () => render(viewBlock("mcp__orchestrator__present", trip, VIEW));

  it("day tabs drive the route map and the timeline; budget, weather, checklist, callout", () => {
    const h = html();
    expect(h).toContain("--gv-accent:#dc9d39");
    expect(h).toMatch(/aria-pressed="true"[^>]*class="gv-seg-opt is-on">Cumartesi</);
    expect(h).toContain('aria-label="Map of 5 stops"');
    expect(h).toContain('class="gv-map__route"');
    expect(count(h, /<li class="gv-tl__item/g)).toBe(5);
    expect(h).toContain('<dd class="gv-kv__value">24° · Güneşli</dd>');
    expect(h).toMatch(/<div class="gv-value__num" aria-live="polite">₺9[.,]400<\/div>/);
    expect(h).toContain('<span class="gv-check__title">Yanına al</span>');
    expect(count(h, /<label class="gv-check__item/g)).toBe(4);
    expect(h).toContain('<div class="gv-callout-title">Konaklama önerisi</div>');
    for (const id of ["calendar", "page", "meyhane"]) expect(h).toContain(`data-action="${id}"`);
    expectNoBrokenParts(h);
    expectProxiedImages(h);
  });

  it("the other day re-filters every lens bound to it", () => {
    setViewState(VIEW, "day", "Pazar");
    const h = html();
    expect(h).toMatch(/aria-pressed="true"[^>]*class="gv-seg-opt is-on">Pazar</);
    const sunday = trip.data.stops.filter((s) => s.day === "Pazar").length;
    expect(h).toContain(`aria-label="Map of ${sunday} stops"`);
    expect(count(h, /<li class="gv-tl__item/g)).toBe(sunday);
  });
});

describe("Tests board", () => {
  const VIEW = "v_testrun12345";
  const html = () => render(viewBlock("mcp__orchestrator__present", tests, VIEW));

  it("KPI stats, the failures disclosure with its trace and file, and the run actions", () => {
    const h = html();
    for (const v of ["404", "5", "3", "38,4s"]) expect(h).toContain(`<span class="gv-stat__value">${v}</span>`);
    expect(h).toContain("gv-stat--alert");
    expect(h).toContain('<span class="gv-stat__delta gv-stat__delta--up is-bad">+4,1s vs main</span>');
    expect(h).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Failures · 5</);
    expect(h).toContain(">Slowest</button>");
    expect(h).toContain(">Flaky · 2</button>");
    expect(h).toContain('<div class="gv-callout-title">3 failures share a root cause</div>');
    expect(h).toMatch(/class="gv-btn gv-btn-primary gv-btn-sm gv-callout-action" data-action="fixAll"/);
    expect(count(h, /<li class="gv-list-item/g)).toBe(5);
    expect(h).toContain('<li class="gv-list-item is-open">');
    expect(h).toContain("Error: connect ECONNREFUSED /tmp/eos-test-81f2/daemon.sock");
    expect(h).toContain('title="manager/peer/__tests__/pair-mutual.test.ts:84"');
    for (const id of ["fixOne", "rerunOne", "rerunFailed", "log"]) expect(h).toContain(`data-action="${id}"`);
    expectNoBrokenParts(h);
  });

  it("the Slowest tab shows a bar meter per slow suite", () => {
    setViewState(VIEW, "tab", "Slowest");
    const h = html();
    expect(h).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Slowest</);
    expect(count(h, /class="gv-meter[ "_]/g)).toBeGreaterThanOrEqual(tests.data.slow.length);
    expect(h).toContain(tests.data.slow[0].name);
  });

  it("the Flaky tab lists the flaky runs with their rate badge", () => {
    setViewState(VIEW, "tab", "Flaky · 2");
    const h = html();
    expect(count(h, /<li class="gv-list-item/g)).toBe(2);
    expect(h).toContain(`${tests.data.flaky[0].rate} flaky`);
  });
});

describe("Learn board", () => {
  const VIEW = "v_learnmerge12";
  const html = () => render(viewBlock("mcp__orchestrator__present", learn, VIEW));

  it("a stepper per mode, the compare table and the quiz", () => {
    const h = html();
    expect(h).toContain("--gv-accent:#b597f5");
    expect(h).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Merge</);
    expect(h).toContain('<div class="gv-steps__count">Step 1 / 3</div>');
    expect(h).toContain(`<div class="gv-steps__title">${learn.data.merge[0].title}</div>`);
    expect(h).toContain(`<code class="gv-steps__code">${learn.data.merge[0].code}</code>`);
    const table = h.slice(h.indexOf('class="gv-table"'), h.indexOf('class="gv-choice"'));
    expect(table).toContain(">Merge<");
    expect(table).toContain(">Rebase<");
    expect(count(table, /<th scope="row"/g)).toBe(learn.data.compare.length);
    expect(h).toContain('<div class="gv-choice__kicker">Quick check</div>');
    expect(count(h, /class="gv-choice__opt"/g)).toBe(3);
    expect(h).toContain('data-action="tryIt"');
    expectNoBrokenParts(h);
  });

  it("the Rebase tab switches to its own stepper", () => {
    setViewState(VIEW, "mode", "Rebase");
    const h = html();
    expect(h).toContain(`<div class="gv-steps__count">Step 1 / ${learn.data.rebase.length}</div>`);
    expect(h).toContain(`<div class="gv-steps__title">${learn.data.rebase[0].title}</div>`);
  });
});

describe("App board — present_app", () => {
  const VIEW = "v_brewtimer123";

  it("frames the agent's app in Eos chrome, sandboxed with no network", () => {
    const h = render(viewBlock("mcp__worker__present_app", app, VIEW));
    expect(h).toContain(`data-genui-view="${VIEW}"`);
    expect(h).toContain("APP · SANDBOXED");
    expect(h).toContain(`<span class="gv-app-title" title="${app.title}">${app.title}</span>`);
    for (const label of ["Reload app", "Open in side panel", "Fullscreen"]) expect(h).toContain(`aria-label="${label}"`);
    expect(h).not.toContain("View source");
    expect(h).toContain(">Save as page</button>");
    const frame = /<iframe[^>]*>/.exec(h)?.[0] ?? "";
    expect(frame).toContain('sandbox="allow-scripts allow-forms"');
    expect(frame).not.toContain("allow-same-origin");
    expect(frame).toContain("connect-src &#x27;none&#x27;");
    expect(frame).toContain("geolocation &#x27;none&#x27;");
    // Our CSP leads the document, before anything the agent wrote.
    const doc = /srcDoc="([^"]*)"/.exec(frame)?.[1] ?? "";
    expect(doc.indexOf("Content-Security-Policy")).toBeGreaterThan(-1);
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("window.eos"));
  });
});

describe("streaming and the action loop", () => {
  it("a present call streaming over genui:delta shows its settled parts, then the finished view", () => {
    const callId = "toolu_stream";
    const full = JSON.stringify(restaurants);
    // Cut right after the Hero closes: Filters, Map and Hero are settled.
    const cut = full.indexOf("</Hero>") + "</Hero>".length;
    expect(cut).toBeGreaterThan(7);
    applyGenuiDelta({ workerId: WORKER, callId, name: "mcp__orchestrator__present", phase: "start", text: "" });
    applyGenuiDelta({ workerId: WORKER, callId, name: "mcp__orchestrator__present", phase: "append", text: full.slice(0, cut) });
    // What Messages overlays while the call has no durable row yet.
    const live = { kind: "view", live: true, ts: 2, tool: { id: callId, name: "mcp__orchestrator__present", verb: "read", input: {}, result: null, running: true, done: false, ts: 2 } };
    const h = render(live);
    expect(h).toContain('aria-busy="true"');
    expect(h).toContain('class="gv-filters"');
    expect(h).toContain('<div class="gv-hero-name">Moda Kıyı</div>');
    expect(h).not.toContain('class="gv-table"');
    expect(h).not.toContain('aria-label="Open in side panel"');

    const done = render(viewBlock("mcp__orchestrator__present", restaurants, "v_streamedone1"));
    expect(done).toContain('class="gv-table"');
    expect(done).toContain('aria-label="Open in side panel"');
  });

  it("a send action leaves a reply chip that names its view", async () => {
    const VIEW = "v_testrun12345";
    const sent = [];
    const rt = createViewRuntime({
      viewId: VIEW,
      viewTitle: tests.title,
      spec: tests,
      scan: scanMarkup(parseMarkup(tests.ui).nodes),
      host: { send: async (text, opts) => { sent.push({ text, ...opts }); return { ok: true }; }, prefill() {}, openUrl() {}, openFile() {}, openExternal() {}, async copy() {} },
    });
    const r = await rt.runAction("rerunFailed");
    expect(r.ok).toBe(true);
    const [{ text, action, queueWhenBusy }] = sent;
    expect(queueWhenBusy).toBe(true);
    expect(action).toMatchObject({ viewId: VIEW, actionId: "rerunFailed", label: tests.actions.rerunFailed.label, viewTitle: tests.title });

    // The daemon stores the label as the user's message, with the action.
    const [user] = buildBlocks([ev("user_message", { text: action.label, action: { viewId: VIEW, label: action.label, viewTitle: tests.title } }, 9)]);
    expect(user.action).toMatchObject({ viewId: VIEW });
    const chip = renderToStaticMarkup(<ViewReplyChip action={user.action} text={user.text} />);
    expect(chip).toContain(`<span class="gv-reply-view">${tests.title}</span>`);
    expect(chip).toContain(`<span class="gv-reply-label">${action.label}</span>`);
    expect(typeof text).toBe("string");
  });
});
