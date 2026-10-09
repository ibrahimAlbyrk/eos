import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import restaurants from "../../../../../../contracts/src/__tests__/fixtures/genui/restaurants.json";
import trip from "../../../../../../contracts/src/__tests__/fixtures/genui/trip.json";
import tests from "../../../../../../contracts/src/__tests__/fixtures/genui/tests.json";
import { count, renderView, textOf } from "../layout/kitHarness.jsx";
import { placeStatus, statusLabel } from "./facts.jsx";
import { currencySymbol, formatAmount, hostOf, openHref, photoSrcs, tpl } from "./util.js";
import { plainInline } from "./text.jsx";
import { MediaImg } from "./media.jsx";

vi.mock("../../../lib/markdown.js", async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, renderMarkdown: mod.markdownToHtml };
});

const view = (ui, opts) => renderView(restaurants, { ui, ...opts });

describe("Text · Heading", () => {
  it("Text renders inline markdown with its size, muted and tone", () => {
    const html = view(`<Text size="lg" tone="amber">Hello **there**</Text>`);
    expect(html).toContain('class="gv-md gv-text gv-text-lg is-toned gv-tone-amber"');
    expect(html).toContain("<strong>there</strong>");
    expect(view(`<Text muted>quiet</Text>`)).toContain('class="gv-md gv-text gv-text-sm is-muted"');
  });

  it("Text never emits raw HTML from the agent", () => {
    const html = view(`<Text>a &lt;script&gt;alert(1)&lt;/script&gt; b</Text>`);
    expect(html).not.toContain("<script");
  });

  it("Heading picks h3/h4/h5 by level, with icon and meta", () => {
    const html = view(`<Heading level="2" icon="star" meta="6 yer">Top **picks**</Heading>`);
    expect(html).toContain('<h4 class="gv-heading-text">Top picks</h4>');
    expect(html).toContain('class="gv-heading-icon"');
    expect(html).toContain('<span class="gv-heading-meta">6 yer</span>');
    expect(view(`<Heading>One</Heading>`)).toContain("<h3");
  });
});

describe("Image · Gallery · Logo", () => {
  it("Image goes through the media proxy, ratio-locked, with a credit badge", () => {
    const html = view(`<Image src="https://example.com/a.jpg" alt="Sea" ratio="4:3" credit="source"/>`);
    expect(html).toContain('style="--gv-ratio:4 / 3"');
    expect(html).toContain("/api/genui/media/img?src=https%3A%2F%2Fexample.com%2Fa.jpg");
    expect(html).toContain('alt="Sea"');
    expect(html).toContain("gv-shimmer");
    expect(html).toContain("© source");
  });

  it("Gallery shows three tiles in a bento and a +N tile", () => {
    const urls = [1, 2, 3, 4, 5].map((i) => `"https://example.com/${i}.jpg"`).join(",");
    const html = view(`<Gallery images={[${urls}]}/>`);
    expect(html).toContain('class="gv-gallery gv-gallery-bento"');
    expect(count(html, 'class="gv-gallery-tile"')).toBe(3);
    expect(html).toContain(">+2<");
  });

  it("Logo tries the site's icon and falls back to a monogram (never a broken image)", () => {
    const html = view(`<Logo site="modakiyi.example" name="Moda Kıyı" size="lg"/>`);
    expect(html).toContain("--gv-logo-size:44px");
    expect(html).toContain("/api/genui/media/icon?site=modakiyi.example");
    const mono = view(`<Logo name="Moda Kıyı"/>`);
    expect(mono).toContain(">MK<");
    expect(mono).not.toContain("<img");
  });

  it("MediaImg with no source renders its fallback", () => {
    const html = renderToStaticMarkup(<MediaImg srcs={[null, ""]} fallback={<i>fallback</i>} />);
    expect(html).toBe("<i>fallback</i>");
  });
});

describe("Badge · Rating · Price · Status", () => {
  it("Badge variants and tones", () => {
    expect(view(`<Badge>Neutral</Badge>`)).toContain('class="gv-badge gv-badge-soft is-neutral"');
    expect(view(`<Badge tone="blue" variant="solid" icon="star">Best match</Badge>`)).toContain('class="gv-badge gv-badge-solid gv-tone-blue is-toned"');
    expect(view(`<Badge tone="amber" variant="outline">socket</Badge>`)).toContain("gv-badge-outline gv-tone-amber");
  });

  it("Rating clips five stars to value/5 and names its source", () => {
    const html = view(`<Rating value="4.7" count="1284" source="1"/>`);
    expect(html).toContain('style="width:94%"');
    expect(html).toContain('<b class="gv-rating-value">4.7</b>');
    expect(html).toMatch(/\(1[,.]?284\)/);
    expect(html).toContain("· Harita kaydı");
    expect(html).toMatch(/aria-label="Rated 4.7 out of 5, 1[,.]?284 reviews"/);
  });

  it("Price shows a level with the dim remainder, or an exact amount", () => {
    const html = view(`<Price level="2" currency="TRY"/>`);
    expect(html).toContain('<span class="gv-price-on" aria-hidden="true">₺₺</span><span class="gv-price-off" aria-hidden="true">₺₺</span>');
    expect(html).toContain('aria-label="Price level 2 of 4"');
    const exact = view(`<Price amount="1250" currency="TRY" per="2 kişi"/>`);
    expect(textOf(exact)).toMatch(/₺1[,.]250 \/ 2 kişi/);
  });

  it("Status colors by state and writes a default label", () => {
    expect(view(`<Status state="open" until="00:00"/>`)).toContain('gv-status gv-status-open');
    expect(textOf(view(`<Status state="open" until="00:00"/>`))).toBe("Open · until 00:00");
    expect(textOf(view(`<Status state="closing" until="21:00"/>`))).toBe("Closing soon · 21:00");
    expect(textOf(view(`<Status state="error">3 failed</Status>`))).toBe("3 failed");
  });

  it("placeStatus reads hours and status from the data, not the clock", () => {
    const [moda, , , rihtim, , sofra] = restaurants.data.places;
    expect(placeStatus(moda)).toEqual({ state: "open", text: "Open · until 00:00" });
    expect(placeStatus(rihtim)).toEqual({ state: "closing", text: "Closing soon · 21:00" });
    expect(placeStatus(sofra)).toEqual({ state: "closed", text: "Bugün kapalı" });
    expect(placeStatus({ hours: "09:00–18:00" })).toEqual({ state: "info", text: "09:00–18:00" });
    expect(placeStatus({})).toBeNull();
    expect(statusLabel("closed")).toBe("Closed");
  });
});

describe("Callout · Quote", () => {
  it("Callout carries kind, icon, title, markdown body and its action", () => {
    const html = renderView(trip, { ui: trip.ui.match(/<Callout[\s\S]*?<\/Callout>/)[0] });
    expect(html).toContain('class="gv-callout gv-callout-tip"');
    expect(html).toContain('<div class="gv-callout-title">Konaklama önerisi</div>');
    expect(html).toContain("yakın butik otel · Alsancak");
    expect(html).toMatch(/<button[^>]*class="gv-btn gv-btn-glass gv-btn-sm gv-callout-action"[^>]*data-action="hotels"/);
    expect(html).toContain("Seçenekleri göster");
  });

  it("a warning callout takes the amber tone and a primary action fills with it", () => {
    const html = renderView(tests, { ui: tests.ui.match(/<Callout[\s\S]*?<\/Callout>/)[0] });
    expect(html).toContain('class="gv-callout gv-callout-warning gv-tone-amber"');
    expect(html).toContain("gv-btn gv-btn-primary gv-btn-sm gv-callout-action");
    expect(html).toContain("<code>connect ECONNREFUSED …/daemon.sock</code>");
  });

  it("Quote shows its cite", () => {
    const html = view(`<Quote cite="Ayşe" source="3">Best fish in town.</Quote>`);
    expect(html).toContain('<figure class="gv-quote">');
    expect(textOf(html)).toContain("— Ayşe · Yorum derlemesi");
  });
});

describe("Code · FileRef", () => {
  it("Code shows raw text, a copy button and its language", () => {
    const html = view(`<Code lang="ts" title="probe">await probeDaemon(sock)
// ECONNREFUSED</Code>`);
    expect(html).toContain('<div class="gv-code-head">probe</div>');
    expect(html).toContain('aria-label="Copy code"');
    expect(textOf(html)).toContain("await probeDaemon(sock) // ECONNREFUSED");
  });

  it("FileRef is a chip with the file name and line", () => {
    const html = view(`<FileRef path="manager/shared/daemon-probe.ts" line="58"/>`);
    expect(html).toMatch(/<button type="button" class="gv-fileref" title="manager\/shared\/daemon-probe.ts:58" aria-label="Open manager\/shared\/daemon-probe.ts:58">/);
    expect(html).toContain("<span>daemon-probe.ts:58</span>");
  });

  it("openHref uses the runtime's open when it has one", () => {
    const calls = [];
    expect(openHref({ open: (h, o) => calls.push([h, o]) }, "a/b.ts", { line: 3 })).toBe(true);
    expect(calls).toEqual([["a/b.ts", { line: 3 }]]);
    expect(openHref({}, "https://x.y")).toBe(false);
  });
});

describe("Sources", () => {
  it("summarizes the sources with a favicon stack and expands to the list", () => {
    const html = view(`<Sources/>`);
    expect(textOf(html)).toContain("4 sources · as of 19:12");
    expect(count(html, 'class="gv-src-fav"')).toBe(3);
    expect(html).toContain('<span class="gv-src-more">+1</span>');
    expect(html).toMatch(/<button type="button" class="gv-src-bar" aria-expanded="false">/);
    expect(html).not.toContain("gv-src-list");
  });

  it("compact drops the Sources word and keeps one line", () => {
    const html = renderView(trip, { ui: `<Sources compact/>` });
    expect(html).toContain('class="gv-sources is-compact"');
    expect(textOf(html)).toBe("1 source · as of 08.10");
  });

  it("renders nothing without sources", () => {
    expect(renderView({ data: {} }, { ui: `<Sources/>` })).toBe('<div class="gv-body"></div>');
  });
});

describe("helpers", () => {
  it("currency symbols and amounts", () => {
    expect(currencySymbol("TRY")).toBe("₺");
    expect(currencySymbol("€")).toBe("€");
    expect(formatAmount("42000", "TRY")).toMatch(/^₺42[,.]000$/);
    expect(formatAmount("about 40", "USD")).toBe("$about 40");
  });

  it("hostOf and photo candidates", () => {
    expect(hostOf("https://www.Example.com/a")).toBe("example.com");
    expect(hostOf("modakiyi.example")).toBe("modakiyi.example");
    expect(hostOf("not a host")).toBe("");
    const media = { img: (u) => `img:${u}`, og: (u) => `og:${u}` };
    expect(photoSrcs({ media }, { image: "https://a/1.jpg", url: "https://a" })).toEqual(["img:https://a/1.jpg", "og:https://a"]);
    expect(photoSrcs({ media }, { name: "x" })).toEqual([]);
  });

  it("tpl fills item fields and leaves plain text alone", () => {
    const v = { template: (s, it) => s.replace("{name}", it?.name ?? "") };
    expect(tpl(v, "{name} · x", { name: "Moda" })).toBe("Moda · x");
    expect(tpl(v, "plain", { name: "Moda" })).toBe("plain");
    expect(plainInline("**bold** and `code` [link](https://x)")).toBe("bold and code link");
  });
});

describe("Gallery from a collection", () => {
  it("collects each item's image field and selects on click", () => {
    const spec = {
      data: {
        rooms: [
          { id: "r1", name: "Sea room", images: ["https://example.com/a.jpg", "https://example.com/b.jpg"] },
          { id: "r2", name: "Garden", image: "https://example.com/c.jpg" },
          { id: "r3", name: "Attic", image: "https://example.com/c.jpg" },
        ],
      },
    };
    const html = renderView(spec, { ui: `<Gallery of="rooms" layout="grid"/>`, selection: { rooms: "r2" } });
    expect(html).toContain('class="gv-gallery gv-gallery-grid"');
    // three distinct URLs; the duplicate is dropped
    expect(count(html, "gv-gallery-tile")).toBe(3);
    expect(html).toMatch(/<button type="button" class="gv-gallery-tile is-selected" aria-pressed="true" aria-label="Garden">/);
  });
});
