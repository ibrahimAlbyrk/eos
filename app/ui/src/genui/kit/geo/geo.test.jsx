import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderSpec } from "../data/testkit.jsx";
import { _reset } from "../../runtime/viewStateStore.js";
import {
  attributionText,
  buildPins,
  fitPositions,
  lngLatBounds,
  pendingAddresses,
  proxiedUrl,
  tuneStyle,
  wantsLocation,
  youCoord,
} from "./mapGeom.js";
import { MAX_LIVE, isLive, liveIds, releaseLive, requestLive, resetLiveMapsForTests, setVisible } from "./liveMaps.js";
import { cachedGeocode, geocode, loadStyle, resetGeoServicesForTests, userLocation } from "./services.js";
import { framingCoords } from "./Map.jsx";
import restaurants from "../../../../../../contracts/src/__tests__/fixtures/genui/restaurants.json";
import trip from "../../../../../../contracts/src/__tests__/fixtures/genui/trip.json";

// MapLibre must never load while rendering: the static map is all a test sees.
vi.mock("maplibre-gl", () => {
  throw new Error("maplibre-gl was imported");
});
vi.mock("../../../lib/markdown.js", async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, renderMarkdown: mod.markdownToHtml };
});
const loc = vi.hoisted(() => ({ calls: 0, reply: { ok: true, status: 200, body: { lat: 40.98, lon: 29.03, accuracy: 30, at: 1 } } }));
vi.mock("../../../api/client.js", () => ({
  api: {
    genuiMapBase: () => "http://127.0.0.1:7400/h/abc/api/genui/map",
    genuiIconUrl: (site) => `http://127.0.0.1:7400/h/abc/api/genui/media/icon?site=${site}`,
    genuiImgUrl: (src) => `http://127.0.0.1:7400/h/abc/api/genui/media/img?src=${src}`,
    genuiOgUrl: (url) => `http://127.0.0.1:7400/h/abc/api/genui/media/og?url=${url}`,
    genuiGeocodeUrl: (q, { limit = 1 } = {}) => `http://127.0.0.1:7400/h/abc/api/genui/geocode?q=${encodeURIComponent(q)}&limit=${limit}`,
    getLocation: async () => {
      loc.calls += 1;
      return loc.reply;
    },
  },
}));

beforeEach(() => {
  _reset();
  resetLiveMapsForTests();
  resetGeoServicesForTests();
  loc.calls = 0;
});

const BASE = "http://127.0.0.1:7400/h/abc/api/genui/map";
const count = (html, needle) => html.split(needle).length - 1;

describe("Map (static render)", () => {
  it("draws a numbered pin per place, the selected one in tone, and the attribution", () => {
    const html = renderSpec({ ...restaurants, ui: '<Map of="places" pin="index" you/>' }, { selection: { places: "lal" } });
    const n = restaurants.data.places.filter((p) => Array.isArray(p.geo)).length;
    expect(count(html, 'class="gv-pinwrap gv-pinwrap--static"')).toBe(n);
    expect(html).toContain('class="gv-pin gv-pin--index is-selected" aria-label="2. Lâl Balık" aria-pressed="true"');
    expect(html).toContain("<span>1</span>");
    expect(html).toContain("OpenStreetMap");
    expect(html).toContain('style="height:240px"');
    expect(html).toContain('role="region" aria-label="Map of 6 places"');
    expect(html).not.toContain("gv-map__zoom");
  });

  it("follows the element's where= and draws the route (Trip board)", () => {
    const ui = '<Segmented bind="day" options="Cumartesi | Pazar" default="Cumartesi"/><Map of="stops" where="day == state.day" pin="index" route height="250"/>';
    const sat = renderSpec({ ...trip, ui });
    expect(count(sat, "gv-pinwrap--static")).toBe(5);
    expect(sat).toContain("<polyline");
    expect(sat).toContain('style="height:250px"');
    const sun = renderSpec({ ...trip, ui }, { state: { day: "Pazar" } });
    expect(count(sun, "gv-pinwrap--static")).toBe(4);
    expect(sun).toContain('aria-label="1. Urla&#x27;ya geçiş"');
  });

  it("dot and logo pins; addresses still resolving show a chip", () => {
    const spec = {
      title: "t",
      summary: "s",
      data: { shops: [{ id: "a", name: "Kahve Dünyası", geo: [41, 29], site: "kahvedunyasi.com" }, { id: "b", name: "Bir Yer", address: "Moda Cd. 1, Kadıköy" }] },
    };
    const dots = renderSpec({ ...spec, ui: '<Map of="shops" pin="dot"/>' });
    expect(dots).toContain("gv-pin gv-pin--dot");
    expect(dots).toContain("Locating addresses…");
    const logos = renderSpec({ ...spec, ui: '<Map of="shops" pin="logo"/>' });
    expect(logos).toContain("gv-pin gv-pin--logo");
    expect(logos).toContain("media/icon?site=kahvedunyasi.com");
  });

  it("no geo at all says so", () => {
    const html = renderSpec({ title: "t", summary: "s", data: { xs: [{ id: 1, name: "x" }] }, ui: '<Map of="xs"/>' });
    expect(html).toContain("No locations to show");
  });
});

describe("pins and framing", () => {
  const places = restaurants.data.places;

  it("buildPins numbers, resolves addresses and marks the selection", () => {
    const items = [{ id: "a", name: "A", geo: [1, 2] }, { id: "b", name: "B", address: "Somewhere 1" }, { id: "c", name: "C" }];
    const pins = buildPins(items, { resolved: new Map([["Somewhere 1", [3, 4]]]), selected: "b", number: (it) => ({ a: 7 })[it.id] });
    expect(pins.map((p) => [p.id, p.n, p.coord, p.selected])).toEqual([
      ["a", 7, [1, 2], false],
      ["b", 2, [3, 4], true],
      ["c", 3, null, false],
    ]);
    expect(pendingAddresses(buildPins(items, {}), new Map())).toEqual(["Somewhere 1"]);
    expect(pendingAddresses(buildPins(items, {}), new Map([["Somewhere 1", null]]))).toEqual([]);
  });

  it("fitPositions keeps every pin inside the padded box, one pin centered", () => {
    const coords = places.map((p) => p.geo);
    const pts = fitPositions(coords, 600, 240, 40);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(40 - 1e-9);
      expect(p.x).toBeLessThanOrEqual(560 + 1e-9);
      expect(p.y).toBeGreaterThanOrEqual(40 - 1e-9);
      expect(p.y).toBeLessThanOrEqual(200 + 1e-9);
    }
    const north = places.reduce((a, b) => (a.geo[0] > b.geo[0] ? a : b));
    expect(pts[places.indexOf(north)].y).toBe(Math.min(...pts.map((p) => p.y)));
    expect(fitPositions([[41, 29]], 600, 240)).toEqual([{ x: 300, y: 120 }]);
  });

  it("bounds, `you` and framing", () => {
    expect(lngLatBounds([[40, 29], [41, 28]])).toEqual([[28, 40], [29, 41]]);
    expect(youCoord([40.9, 29.1])).toEqual([40.9, 29.1]);
    expect(youCoord(true)).toBe(null);
    expect(wantsLocation(true)).toBe(true);
    expect(wantsLocation([1, 2])).toBe(false);
    const pins = [{ coord: [40.98, 29.02] }, { coord: null }];
    expect(framingCoords(pins, [40.99, 29.03])).toHaveLength(2);
    expect(framingCoords(pins, [52.5, 13.4])).toHaveLength(1);
  });

  it("every map request goes through the daemon proxy", () => {
    expect(proxiedUrl("https://tiles.openfreemap.org/planet/1/2/3.pbf", BASE)).toBe(`${BASE}/t/planet/1/2/3.pbf`);
    expect(proxiedUrl("/api/genui/map/t/fonts/a/0-255.pbf", BASE)).toBe(`${BASE}/t/fonts/a/0-255.pbf`);
    expect(proxiedUrl("eos://app/api/genui/map/t/sprites/ofm", BASE)).toBe(`${BASE}/t/sprites/ofm`);
    expect(proxiedUrl(`${BASE}/t/x`, BASE)).toBe(`${BASE}/t/x`);
    expect(proxiedUrl("https://example.com/x.png", BASE)).toBe("https://example.com/x.png");
    const style = tuneStyle(
      {
        sources: { omt: { url: "/api/genui/map/t/planet" } },
        glyphs: "/api/genui/map/t/fonts/{fontstack}/{range}.pbf",
        layers: [{ id: "background", type: "background", paint: {} }, { id: "water", type: "fill", paint: { "fill-color": "#000" } }, { id: "road", type: "line" }],
      },
      BASE,
    );
    expect(style.sources.omt.url).toBe(`${BASE}/t/planet`);
    expect(style.glyphs).toBe(`${BASE}/t/fonts/{fontstack}/{range}.pbf`);
    expect(style.layers[0].paint["background-color"]).toBe("#141414");
    expect(style.layers[1].paint["fill-color"]).toBe("#0f1b26");
    expect(style.layers[2]).toEqual({ id: "road", type: "line" });
  });

  it("attribution strings lose their HTML", () => {
    expect(attributionText(['<a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="x">OpenMapTiles</a>', "Data from OpenStreetMap", "Data from OpenStreetMap"])).toBe(
      "OpenFreeMap © OpenMapTiles · Data from OpenStreetMap",
    );
  });
});

describe("live map budget", () => {
  it("keeps at most MAX_LIVE maps, evicting the oldest offscreen one first", () => {
    const evicted = [];
    const ev = (id) => () => evicted.push(id);
    requestLive("a", ev("a"));
    requestLive("b", ev("b"));
    requestLive("c", ev("c"));
    expect(liveIds()).toHaveLength(MAX_LIVE);
    setVisible("b", false);
    requestLive("d", ev("d"));
    expect(evicted).toEqual(["b"]);
    expect(isLive("b")).toBe(false);
    requestLive("e", ev("e"));
    expect(evicted).toEqual(["b", "a"]);
    requestLive("c", ev("c"));
    requestLive("f", ev("f"));
    expect(evicted).toEqual(["b", "a", "d"]);
    releaseLive("c");
    expect(liveIds().sort()).toEqual(["e", "f"]);
  });
});

describe("daemon services", () => {
  it("geocodes one address at a time and caches the answers", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetcher = async (q) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      if (q === "boom") throw new Error("503");
      return q === "nowhere" ? null : [1, q.length];
    };
    const [a, b, c, d] = await Promise.all([geocode("abc", fetcher), geocode("abcd", fetcher), geocode("nowhere", fetcher), geocode("boom", fetcher)]);
    expect(peak).toBe(1);
    expect([a, b, c, d]).toEqual([[1, 3], [1, 4], null, null]);
    expect(cachedGeocode("abc")).toEqual([1, 3]);
    expect(cachedGeocode("nowhere")).toBe(null);
    expect(cachedGeocode("boom")).toBe(undefined);
    let again = 0;
    await geocode("abc", async () => {
      again++;
      return [0, 0];
    });
    expect(again).toBe(0);
  });

  it("asks for the user's location once per session window", async () => {
    expect(await userLocation()).toEqual([40.98, 29.03]);
    expect(await userLocation()).toEqual([40.98, 29.03]);
    expect(loc.calls).toBe(1);
  });

  it("loads the style once per base, proxied", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ glyphs: "/api/genui/map/t/fonts/{fontstack}/{range}.pbf", layers: [] }) }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const [s1, s2] = await Promise.all([loadStyle(BASE), loadStyle(BASE)]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/style.json`);
      expect(s1).toBe(s2);
      expect(s1.glyphs).toBe(`${BASE}/t/fonts/{fontstack}/{range}.pbf`);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
