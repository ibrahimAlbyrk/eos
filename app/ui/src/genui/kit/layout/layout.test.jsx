import { describe, it, expect, vi } from "vitest";
import restaurants from "../../../../../../contracts/src/__tests__/fixtures/genui/restaurants.json";
import tests from "../../../../../../contracts/src/__tests__/fixtures/genui/tests.json";
import learn from "../../../../../../contracts/src/__tests__/fixtures/genui/learn.json";
import { COMPONENTS } from "../../../../../../contracts/src/genui/catalog.ts";
import { components as layout } from "./index.js";
import { components as content } from "../content/index.js";
import { components as entities } from "../entities/index.js";
import { count, renderView, textOf } from "./kitHarness.jsx";

// DOMPurify needs a DOM; the node test env has none, so render unsanitized.
vi.mock("../../../lib/markdown.js", async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, renderMarkdown: mod.markdownToHtml };
});

const groupNames = (group) => Object.entries(COMPONENTS).filter(([, d]) => d.group === group).map(([n]) => n).sort();

describe("Kit A exports", () => {
  it("each group exports exactly its catalog names", () => {
    expect(Object.keys(layout).sort()).toEqual(groupNames("layout"));
    expect(Object.keys(content).sort()).toEqual(groupNames("content"));
    expect(Object.keys(entities).sort()).toEqual(groupNames("entities"));
    for (const c of [...Object.values(layout), ...Object.values(content), ...Object.values(entities)]) expect(typeof c).toBe("function");
  });
});

describe("Section", () => {
  it("shows its title as a section label above the children", () => {
    const html = renderView(restaurants, { ui: `<Section title="Diğer seçenekler" meta="5" icon="star"><Text>body</Text></Section>` });
    expect(html).toContain('class="gv-section"');
    expect(html).toMatch(/class="gv-section-label"[^>]*role="heading"/);
    expect(textOf(html)).toContain("Diğer seçenekler · 5 body");
  });

  it("collapsed starts closed behind a toggle", () => {
    const html = renderView(restaurants, { ui: `<Section title="More" collapsed><Text>hidden body</Text></Section>` });
    expect(html).toMatch(/<button[^>]*class="gv-section-label is-toggle"[^>]*aria-expanded="false"/);
    expect(html).not.toContain("hidden body");
  });
});

describe("Stack · Grid · Split", () => {
  it("Stack maps dir / gap / align / wrap to classes", () => {
    const html = renderView(restaurants, { ui: `<Stack dir="row" gap="lg" align="end" wrap><Badge>a</Badge><Badge>b</Badge></Stack>` });
    expect(html).toContain('class="gv-stack gv-stack-row gv-gap-lg gv-align-end is-wrap"');
  });

  it("Grid carries its column count and minimum width", () => {
    const html = renderView(tests, { ui: tests.ui.split("<Tabs")[0] });
    expect(html).toMatch(/class="gv-grid gv-gap-sm" style="--gv-cols:4;--gv-min:140px"/);
  });

  it("Split turns the ratio into two tracks (stacking is a container query)", () => {
    const html = renderView(restaurants, { ui: `<Split ratio="2:1"><Text>a</Text><Text>b</Text></Split>` });
    expect(html).toContain('<div class="gv-split"><div class="gv-split-grid gv-align-stretch" style="--gv-split-a:2fr;--gv-split-b:1fr">');
  });
});

describe("Tabs", () => {
  it("labels come from labels= and only the active child renders", () => {
    const html = renderView(learn, { ui: learn.ui.split("<Table")[0] });
    expect(html).toMatch(/role="tablist"/);
    expect(count(html, 'role="tab"')).toBe(2);
    expect(html).toMatch(/aria-selected="true"[^>]*>Merge</);
    // Merge has three steps, Rebase four: only Merge's stepper is mounted.
    expect(html).toContain("Step 1 / 3");
    expect(html).not.toContain("Step 1 / 4");
  });

  it("a bound tab reads its label from view state", () => {
    const html = renderView(learn, { ui: learn.ui.split("<Table")[0], state: { mode: "Rebase" } });
    expect(html).toMatch(/aria-selected="true"[^>]*>Rebase</);
    expect(html).toContain("Step 1 / 4");
  });

  it("child label= names a tab when labels= is absent", () => {
    const html = renderView(tests, { ui: tests.ui.slice(tests.ui.indexOf("<Tabs"), tests.ui.indexOf("</Tabs>") + 7) });
    expect(textOf(html)).toContain("Failures · 5 Slowest Flaky · 2");
    expect(html).toContain("3 failures share a root cause");
  });
});

describe("Disclosure · Divider", () => {
  it("Disclosure is a button row; its body renders only when open", () => {
    const closed = renderView(restaurants, { ui: `<Disclosure title="Details" meta="3" badge="new"><Text>inside</Text></Disclosure>` });
    expect(closed).toMatch(/<button[^>]*class="gv-disclosure-row"[^>]*aria-expanded="false"/);
    expect(closed).not.toContain("inside");
    expect(textOf(closed)).toContain("Details new 3");
    const open = renderView(restaurants, { ui: `<Disclosure title="Details" open><Text>inside</Text></Disclosure>` });
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain("inside");
  });

  it("Divider is a separator, with its label when given", () => {
    expect(renderView(restaurants, { ui: `<Divider/>` })).toContain('<div class="gv-divider" role="separator"></div>');
    const labeled = renderView(restaurants, { ui: `<Divider label="or"/>` });
    expect(labeled).toContain('aria-label="or"');
    expect(labeled).toContain('<span class="gv-divider-text">or</span>');
  });
});

describe("Carousel", () => {
  const ui = `<Carousel of="places" skip="moda" card="compact" meta="{cuisine} · {area}"/>`;

  it("renders one compact card per item, skipping skip=", () => {
    const html = renderView(restaurants, { ui });
    expect(html).toMatch(/role="region" aria-roledescription="carousel" aria-label="5 items"/);
    expect(count(html, 'class="gv-carousel-slide"')).toBe(5);
    expect(html).not.toContain("Moda Kıyı");
    expect(html).toContain("Lâl Balık");
    expect(html).toContain("Balık · Çarşı");
    expect(html).toContain('aria-label="1 of 5"');
  });

  it("numbers cards like the map pins (position in the collection)", () => {
    const html = renderView(restaurants, { ui });
    // lal is the second place: its card carries 2, not 1.
    expect(html).toMatch(/<span class="gv-card-num" aria-hidden="true">2<\/span>.*Lâl Balık/);
  });

  it("rings the selected entity and exposes it as pressed", () => {
    const html = renderView(restaurants, { ui, selection: { places: "lal" } });
    expect(html).toMatch(/class="gv-card gv-card-compact gv-kind-place is-selected is-selectable"><button class="gv-card-hit" type="button" aria-pressed="true">.*?Lâl Balık/);
    expect(count(html, 'aria-pressed="true"')).toBe(1);
  });

  it("applies the Filters chips: only open places stay", () => {
    const html = renderView(restaurants, { ui: `<Filters of="places" chips="Open: open" on="0"/>${ui}` });
    expect(html).not.toContain("Sofra Moda");
    expect(count(html, 'class="gv-carousel-slide"')).toBe(4);
  });

  it("lays out child elements when there is no of=", () => {
    const html = renderView(restaurants, {
      ui: `<Carousel><Card of="places" pick="moda"/><Card of="places" pick="lal"/><Card of="places" pick="ocak"/></Carousel>`,
    });
    expect(count(html, 'class="gv-carousel-slide"')).toBe(3);
    expect(html).toContain("Ocak 34");
  });

  it("has prev/next buttons with labels", () => {
    const html = renderView(restaurants, { ui });
    expect(html).toMatch(/aria-label="Previous" disabled=""/);
    expect(html).toContain('aria-label="Next"');
  });
});
