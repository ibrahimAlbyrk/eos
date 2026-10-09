import { describe, it, expect, vi } from "vitest";
import restaurants from "../../../../../../contracts/src/__tests__/fixtures/genui/restaurants.json";
import tests from "../../../../../../contracts/src/__tests__/fixtures/genui/tests.json";
import { count, renderView, textOf } from "../layout/kitHarness.jsx";
import { defaultMeta, eventDay, formatDistance, kindOf } from "./entity.jsx";

vi.mock("../../../lib/markdown.js", async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, renderMarkdown: mod.markdownToHtml };
});

const heroUi = restaurants.ui.match(/<Hero[\s\S]*?<\/Hero>/)[0];

const mixed = {
  title: "Mixed",
  data: {
    things: [
      { id: "p1", type: "Product", name: "Aero 14", price: 42000, currency: "TRY", inStock: true, specs: { screen: '13.8"', weight: "1,24 kg", battery: "18 h" }, image: "https://example.com/aero.jpg" },
      { id: "e1", type: "Event", name: "Jazz night", start: "2026-10-18 21:00", venue: "Moda" },
      { id: "u1", type: "Person", name: "Deniz Kaya", role: "Maintainer", org: "relay/" },
      { id: "f1", type: "File", path: "manager/routes/workers.ts", added: 42, removed: 7 },
      { id: "m1", type: "Media", name: "How rebase rewrites history", kind: "video", duration: "12:04", site: "video.example", date: "2025" },
      { id: "a1", type: "Article", title: "Rebase vs merge", url: "https://blog.example/rebase", date: "2025", excerpt: "A short read." },
      { id: "g1", type: "Generic", name: "Something", note: "a note" },
    ],
  },
  actions: { buy: { label: "Buy", kind: "send", primary: true, text: "Buy {name}" } },
};

describe("Hero", () => {
  it("shows the pick large: badge, name, meta, facts, reason and actions", () => {
    const html = renderView(restaurants, { ui: heroUi });
    expect(html).toContain('class="gv-hero-wrap"');
    expect(html).toContain('<div class="gv-hero-name">Moda Kıyı</div>');
    expect(html).toContain('<div class="gv-hero-meta">Meyhane · Deniz ürünü · Moda</div>');
    expect(textOf(html)).toContain("En iyi eşleşme");
    expect(textOf(html)).toContain("650 m · 9 dk");
    expect(textOf(html)).toContain("Open · until 00:00");
    expect(html).toContain("Why this · ");
    expect(html).toContain("<strong>masa ayırtmak</strong>");
    // book (primary), route (open maps:), menu (open {url}) — in that order.
    expect(html).toMatch(/data-action="book".*data-action="route".*data-action="menu"/);
    expect(html).toContain('class="gv-btn gv-btn-primary"');
    // menu already opens {url}, so no separate website button; geo gives "Show on map".
    expect(html).not.toContain('aria-label="Open website"');
    expect(html).toContain('aria-label="Show on map"');
  });

  it("is hidden while the Filters chips exclude its pick", () => {
    const ui = `<Filters of="places" chips="Cheap: price<=1" on="0"/>${heroUi}`;
    expect(renderView(restaurants, { ui })).not.toContain("gv-hero");
  });

  it("shows a skeleton while the view streams and the pick hasn't arrived", () => {
    const spec = { ...restaurants, data: { places: [] } };
    expect(renderView(spec, { ui: heroUi, streaming: true })).toContain("gv-hero-skeleton");
    expect(renderView(spec, { ui: heroUi })).not.toContain("gv-hero");
  });

  it("rings when its entity is selected", () => {
    expect(renderView(restaurants, { ui: heroUi, selection: { places: "moda" } })).toContain('class="gv-hero is-selected"');
  });
});

describe("Card", () => {
  it("place compact: photo fallback, overlapping logo, facts and status", () => {
    const html = renderView(restaurants, { ui: `<Card of="places" pick="lal"/>` });
    expect(html).toContain('class="gv-card gv-card-compact gv-kind-place is-selectable"');
    expect(html).toContain("gv-card-logo");
    expect(textOf(html)).toContain("Lâl Balık Balık · Çarşı");
    expect(html).toContain("Rated 4.6 out of 5");
    expect(html).toContain("400 m");
    expect(html).toContain("gv-status-open");
  });

  it("place row: thumb, meta with rating and price, distance trailing", () => {
    const html = renderView(restaurants, { ui: `<Card of="places" pick="moda" variant="row"/>` });
    expect(html).toContain("gv-card-row");
    expect(html).toContain('class="gv-card-hit gv-card-rowgrid"');
    expect(html).toContain('<span class="gv-card-trail">650 m</span>');
    expect(html).toContain("gv-facts is-inline");
  });

  it("hero variant uses the hero layout", () => {
    const html = renderView(restaurants, { ui: `<Card of="places" pick="yel" variant="hero" badge="{area}"/>` });
    expect(html).toContain('<div class="gv-hero-name">Yel Meyhane</div>');
    expect(textOf(html)).toContain("Yeldeğirmeni");
  });

  it("templated meta and badge read the item", () => {
    const html = renderView(restaurants, { ui: `<Card of="places" pick="ocak" meta="{area} · {walk}" badge="{reviews} yorum"/>` });
    expect(html).toContain('<span class="gv-card-meta">Bahariye · 12 dk</span>');
    expect(textOf(html)).toContain("860 yorum");
  });

  it("product: contained image, specs and price with stock", () => {
    const html = renderView(mixed, { ui: `<Card of="things" pick="p1" actions="buy"/>` });
    expect(html).toContain("gv-kind-product");
    expect(html).toContain('13.8&quot; · 1,24 kg · 18 h');
    expect(textOf(html)).toMatch(/₺42[,.]000/);
    expect(textOf(html)).toContain("In stock");
    expect(html).toMatch(/class="gv-actions gv-card-actions".*data-action="buy"/);
  });

  it("event, person, file and generic cards use the tile layout", () => {
    const ev = renderView(mixed, { ui: `<Card of="things" pick="e1"/>` });
    expect(ev).toContain("gv-card-tile gv-kind-event");
    expect(ev).toContain('<span class="gv-dateleaf-month">OCT</span><span class="gv-dateleaf-day">18</span>');
    const person = renderView(mixed, { ui: `<Card of="things" pick="u1"/>` });
    expect(person).toContain(">DK<");
    expect(textOf(person)).toContain("Maintainer · relay/");
    const file = renderView(mixed, { ui: `<Card of="things" pick="f1"/>` });
    expect(file).toContain('<span class="gv-add">+42</span><span class="gv-del">−7</span>');
    expect(file).toContain("manager/routes/workers.ts");
    expect(renderView(mixed, { ui: `<Card of="things" pick="g1"/>` })).toContain("a note");
  });

  it("media and article cards: play overlay, duration and excerpt", () => {
    const media = renderView(mixed, { ui: `<Card of="things" pick="m1"/>` });
    expect(media).toContain("gv-card-play");
    expect(media).toContain('<span class="gv-card-duration">12:04</span>');
    expect(textOf(media)).toContain("video.example · 2025");
    const art = renderView(mixed, { ui: `<Card of="things" pick="a1"/>` });
    expect(art).toContain("/api/genui/media/og?url=");
    expect(art).toContain('<span class="gv-card-excerpt">A short read.</span>');
  });

  it("an unknown pick renders nothing", () => {
    expect(renderView(restaurants, { ui: `<Card of="places" pick="nope"/>` })).toBe('<div class="gv-body"></div>');
  });
});

describe("List", () => {
  const failures = tests.ui.match(/<List of="failures"[\s\S]*?<\/List>/)[0];

  it("disclosure rows: the first opens with its per-item detail filled from the item", () => {
    const html = renderView(tests, { ui: failures });
    expect(count(html, 'class="gv-list-item')).toBe(5);
    expect(count(html, 'aria-expanded="true"')).toBe(1);
    expect(count(html, 'aria-expanded="false"')).toBe(4);
    expect(html).toContain("reciprocal:true adopts the device as a host");
    expect(html).toContain('class="gv-list-meta is-mono"');
    // Code value="{trace}" and FileRef path="{file}" line="{line}" read the open item.
    expect(html).toContain("connect ECONNREFUSED /tmp/eos-test-81f2/daemon.sock");
    expect(html).toContain("<span>pair-mutual.test.ts:84</span>");
    expect(html).toMatch(/gv-list-detail.*data-action="fixOne".*Fix with a worker/);
  });

  it("untoned badges get a stable tone from their text", () => {
    const html = renderView(tests, { ui: failures });
    const socket = html.match(/class="gv-badge gv-badge-soft gv-tone-(\w+) is-toned gv-list-badge"><span>socket</g) ?? [];
    expect(socket.length).toBe(3);
    expect(new Set(socket).size).toBe(1);
  });

  it("row lists select their entity and number their rows", () => {
    const html = renderView(restaurants, { ui: `<List of="places" numbered meta="{cuisine}" limit="3"/>`, selection: { places: "lal" } });
    expect(count(html, 'class="gv-list-item')).toBe(3);
    expect(html).toContain('<span class="gv-list-num">2</span>');
    expect(html).toMatch(/class="gv-list-item is-selected".*?aria-pressed="true"/);
  });

  it("an empty list after Filters offers to clear them", () => {
    const ui = `<Filters of="places" chips="Nothing: rating>5" on="0"/><List of="places"/>`;
    const html = renderView(restaurants, { ui });
    expect(html).not.toContain("gv-list-item");
    expect(html).toContain("Clear filters");
  });
});

describe("entity helpers", () => {
  it("reads kinds, meta lines, distances and event days", () => {
    expect(kindOf({ entityKind: () => "Place" }, {})).toBe("place");
    expect(kindOf({ entityKind: () => "Place" }, {}, "Person")).toBe("person");
    expect(kindOf({}, { type: "Nope" })).toBe("generic");
    expect(defaultMeta("place", restaurants.data.places[1])).toBe("Balık · Çarşı");
    expect(defaultMeta("person", { role: "Dev", org: "Eos" })).toBe("Dev · Eos");
    expect(formatDistance(650)).toBe("650 m");
    expect(formatDistance(1400)).toBe("1.4 km");
    expect(formatDistance("1,4 km")).toBe("1,4 km");
    expect(eventDay("2026-10-18T21:00")).toEqual({ month: "Oct", day: "18" });
    expect(eventDay("18 Ekim 21:00")).toEqual({ month: "Eki", day: "18" });
    expect(eventDay("soon")).toBeNull();
  });
});
