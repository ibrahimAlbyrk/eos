import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderSpec } from "./testkit.jsx";
import { _reset } from "../../runtime/viewStateStore.js";
import restaurants from "../../../../../../contracts/src/__tests__/fixtures/genui/restaurants.json";
import trip from "../../../../../../contracts/src/__tests__/fixtures/genui/trip.json";
import tests from "../../../../../../contracts/src/__tests__/fixtures/genui/tests.json";
import learn from "../../../../../../contracts/src/__tests__/fixtures/genui/learn.json";

// DOMPurify needs a DOM; the plain renderer is enough for markup assertions.
vi.mock("../../../lib/markdown.js", async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, renderMarkdown: mod.markdownToHtml };
});

beforeEach(() => _reset());

const count = (html, needle) => html.split(needle).length - 1;
const withUi = (spec, ui) => ({ ...spec, ui });

describe("Stat", () => {
  it("renders the Tests board KPI tiles: mono label, value, tone, delta", () => {
    const ui = tests.ui.slice(0, tests.ui.indexOf("</Grid>") + 7);
    const html = renderSpec(withUi(tests, ui));
    expect(html.match(/class="gv-stat( [^"]*)?"/g)).toHaveLength(4);
    expect(html).toContain('<div class="gv-stat__label">Passed</div>');
    expect(html).toContain("gv-stat gv-stat--toned gv-stat--alert");
    expect(html).toContain('<span class="gv-stat__value">404</span>');
    expect(html).toContain('class="gv-stat__delta gv-stat__delta--up is-bad">+4,1s vs main<');
    expect(html).toContain('<div class="gv-stat__meta">platform-gated</div>');
  });

  it("fills templates from data and draws a sparkline from a number list", () => {
    const html = renderSpec({ title: "t", summary: "s", data: { run: { total: 412 } }, ui: '<Stat label="Tests" value="{run.total}" spark={[3,5,4,8]}/>' });
    expect(html).toContain(">412<");
    expect(html).toContain('class="gv-spark"');
  });

  it("cites its source on the meta line, a footnote number when the source has no name", () => {
    const sources = [{ title: "GitHub", url: "https://github.com/x" }, { url: "https://example.com/y" }];
    const at = (ui) => renderSpec({ title: "t", summary: "s", data: { sources }, ui });
    expect(at('<Stat label="Commits" value="1.382" meta="son 30 gün" source={1}/>')).toContain('<div class="gv-stat__meta">son 30 gün · GitHub</div>');
    expect(at('<Stat label="Commits" value="1.382" source="1"/>')).toContain('<div class="gv-stat__meta">GitHub</div>');
    expect(at('<Stat label="Commits" value="1.382" meta="son 30 gün" source={2}/>')).toContain('<div class="gv-stat__meta">son 30 gün<sup class="gv-footref">2</sup></div>');
  });
});

describe("KeyValue", () => {
  it("renders rows from a collection with key/value templates", () => {
    const html = renderSpec(withUi(trip, '<KeyValue of="weather" key="{day}" value="{temp} · {sky}"/>'));
    expect(html).toContain('<dt class="gv-kv__key">Cumartesi</dt>');
    expect(html).toContain('<dd class="gv-kv__value">24° · Güneşli</dd>');
  });

  it("renders an items object", () => {
    const html = renderSpec({ title: "t", summary: "s", ui: '<KeyValue items={{"Battery":"18 h","Ports":"2× USB-C"}} cols="2"/>' });
    expect(html).toContain("gv-kv gv-kv--2");
    expect(html).toContain(">Battery<");
    expect(html).toContain(">2× USB-C<");
  });
});

describe("Table", () => {
  const ui = '<Table of="places" cols="name:Mekan, rating:Puan, price:Fiyat, distance:Mesafe, hours:Kapanış" best="rating:max price:min" numbered/>';

  it("renders the compare table with sortable headers, numbers and best cells", () => {
    const html = renderSpec(withUi(restaurants, ui));
    expect(count(html, "<tr")).toBe(restaurants.data.places.length + 1);
    expect(count(html, 'class="gv-table__head"')).toBe(5);
    expect(html).toContain('class="gv-table__num" aria-hidden="true">1<');
    expect(html).toMatch(/gv-cell--rating is-best">★ 4\.7</);
    expect(html).toContain(">00:00<");
  });

  it("with another lens on the collection, rows select through a pressed-state button", () => {
    const html = renderSpec(withUi(restaurants, `<Map of="places"/>${ui}`), { selection: { places: "lal" } });
    expect(count(html, 'class="is-selectable is-selected"')).toBe(1);
    expect(count(html, 'class="gv-table__pick" aria-pressed="true"')).toBe(1);
    expect(count(html, 'class="gv-table__pick" aria-pressed="false"')).toBe(restaurants.data.places.length - 1);
    expect(html).not.toContain("aria-selected");
  });

  it("a lone table is read-only: no row tab stops, nothing to select", () => {
    const html = renderSpec(withUi(restaurants, ui), { selection: { places: "lal" } });
    expect(html).not.toContain("gv-table__pick");
    expect(html).not.toContain("is-selectable");
    expect(html).not.toMatch(/<tr[^>]*tabindex/);
  });

  it("an empty header label makes the first column a row header (Learn compare)", () => {
    const html = renderSpec(withUi(learn, '<Table of="compare" cols="aspect:, merge:Merge, rebase:Rebase"/>'));
    expect(html).toContain('class="gv-table__rowhead gv-cell--text">Geçmiş<');
    expect(html).toContain(">Merge<");
  });

  it("shows the filter empty state when the chips hide every row", () => {
    const spec = withUi(restaurants, `<Filters of="places" chips="Nope: tags~zzz" on="0"/>${ui}`);
    const html = renderSpec(spec);
    expect(html).toContain("Nothing matches these filters");
    expect(html).not.toContain("<table");
  });

  it("row actions render as small buttons", () => {
    const html = renderSpec(withUi(restaurants, '<Table of="places" cols="name rating" actions="book"/>'));
    expect(count(html, 'data-action="book"')).toBe(restaurants.data.places.length);
  });
});

describe("Chart", () => {
  const spec = {
    title: "Runs",
    summary: "s",
    tone: "teal",
    data: { runs: [{ run: "r1", t: 30 }, { run: "r2", t: 34 }, { run: "r3", t: 31 }], spend: [{ k: "Stay", v: 48 }, { k: "Food", v: 34 }, { k: "Travel", v: 18 }] },
  };

  it("draws a bar chart with the max bar in tone and the rest dimmed", () => {
    const html = renderSpec({ ...spec, ui: '<Chart type="bar" of="runs" x="run" y="t"/>' });
    expect(count(html, "<path")).toBe(3);
    expect(html).toContain('fill="#26c1c8"');
    expect(count(html, 'fill="#1b4243"')).toBe(2);
    expect(html).toContain('role="img"');
    expect(html).toContain(">r2<");
  });

  it("draws line and area charts with grid labels and the unit", () => {
    const line = renderSpec({ ...spec, ui: '<Chart type="line" of="runs" x="run" y="t" unit="s"/>' });
    expect(line).toContain('stroke="#26c1c8"');
    expect(line).toMatch(/>3\ds</);
    const area = renderSpec({ ...spec, ui: '<Chart type="area" of="runs" x="run" y="t"/>' });
    expect(area).toContain("<linearGradient");
    expect(area).toContain('fill="url(#gvar-');
  });

  it("draws a donut with a percentage legend", () => {
    const html = renderSpec({ ...spec, ui: '<Chart type="donut" of="spend" x="k" y="v"/>' });
    expect(html).toContain('stroke-dasharray="48 52"');
    expect(html).toContain(">Stay<");
    expect(html).toMatch(/48\s?%/);
  });

  it("draws a sparkline from values=", () => {
    const html = renderSpec({ ...spec, ui: '<Chart type="sparkline" values={[1,3,2,5]}/>' });
    expect(html).toContain('class="gv-spark"');
  });
});

describe("Meter", () => {
  it("renders one bar per item scaled to max (Tests board Slowest)", () => {
    const html = renderSpec(withUi(tests, '<Meter of="slow" label="{name}" value="t" max="9.8" unit="s"/>'));
    expect(count(html, 'class="gv-meter__row')).toBe(6);
    expect(html).toContain('style="width:100%"');
    expect(html).toContain(">peer/<");
    expect(html).toMatch(/9[.,]8s</);
  });

  it("renders a single bar", () => {
    const html = renderSpec({ title: "t", summary: "s", ui: '<Meter value="8.6" label="Value" tone="green"/>' });
    expect(html).toContain('style="width:86%"');
    expect(html).toContain("--gv-meter-fill:#61c380");
  });
});

describe("Timeline", () => {
  const ui = '<Segmented bind="day" options="Cumartesi | Pazar" default="Cumartesi"/><Timeline of="stops" where="day == state.day" time="{time}" title="{name}" note="{note}" meta="{dur}" leg="{leg}" numbered/>';

  it("shows the stops of the selected day, numbered, with legs between them", () => {
    const html = renderSpec(withUi(trip, ui));
    expect(count(html, 'class="gv-tl__stop')).toBe(5);
    expect(html).toContain('<span class="gv-tl__time">09:30</span>');
    expect(html).toContain('<span class="gv-tl__num">1</span>');
    expect(html).toContain(">Yürüyüş · 8 dk<");
    expect(count(html, 'class="gv-tl__leg"')).toBe(4);
    expect(html).toContain('<span class="gv-tl__meta">1,5 sa</span>');
  });

  it("follows the bound day and the selection", () => {
    const html = renderSpec(withUi(trip, ui), { state: { day: "Pazar" }, selection: { stops: "s7" } });
    expect(count(html, 'class="gv-tl__stop')).toBe(4);
    expect(html).toContain(">Bağ yolu<");
    expect(count(html, "gv-tl__stop is-selected")).toBe(1);
  });
});

describe("Steps", () => {
  it("stepper shows one step with its count, caption, dots and command", () => {
    const html = renderSpec(withUi(learn, '<Steps of="rebase" variant="stepper" bind="s" title="{title}" text="{text}" code="{code}"/>'));
    expect(html).toContain(">Step 1 / 4<");
    expect(html).toContain("Başlangıç: iki geçmiş ayrıldı");
    expect(html.match(/class="gv-steps__dot( [^"]*)?"/g)).toHaveLength(4);
    expect(html).toContain('aria-label="Previous step" disabled=""');
    expect(html).toContain("git log --graph --oneline");
  });

  it("reads the current step from state", () => {
    const html = renderSpec(withUi(learn, '<Steps of="rebase" variant="stepper" bind="s"/>'), { state: { s: 3 } });
    expect(html).toContain(">Step 4 / 4<");
    expect(html).toContain("Sonuç: tek çizgi geçmiş");
    expect(html).toMatch(/class="gv-btn gv-btn-primary" disabled=""/);
  });

  it("list variant numbers every step; child elements can be steps", () => {
    const list = renderSpec(withUi(learn, '<Steps of="merge"/>'));
    expect(count(list, 'class="gv-steps__item')).toBe(3);
    const kids = renderSpec({ title: "t", summary: "s", ui: '<Steps variant="stepper"><Text label="One">first</Text><Text label="Two">second</Text></Steps>' });
    expect(kids).toContain(">Step 1 / 2<");
    expect(kids).toContain(">One<");
    expect(kids).toContain("<p>first</p>");
    expect(kids).not.toContain("<p>second</p>");
  });
});

describe("Progress and Value", () => {
  it("Value computes and formats an expression (Trip budget)", () => {
    const html = renderSpec(withUi(trip, '<Value label="Tahmini bütçe" expr="sum(budget.amount)" format="currency" currency="TRY" size="lg"/>'));
    expect(html).toContain('<div class="gv-value__label">Tahmini bütçe</div>');
    expect(html).toMatch(/9[.,\u00a0]?400/);
    expect(html).toContain("gv-value--lg");
  });

  it("Value reads bound state (Slider → fv)", () => {
    const html = renderSpec({ title: "t", summary: "s", ui: '<Slider bind="save" min="500" max="10000" default="3000"/><Value expr="round(fv(save, 0.2, 5))" format="int" tone="teal"/>' });
    expect(html).toContain("gv-value--toned");
    expect(html).toMatch(/305[.,\u00a0]?275/);
  });

  it("Progress shows value/max", () => {
    const html = renderSpec({ title: "t", summary: "s", ui: '<Progress value="3" max="4" label="Packed"/>' });
    expect(html).toContain('aria-valuenow="75"');
    expect(html).toContain(">3 / 4<");
    expect(html).toContain(">Packed<");
  });
});
