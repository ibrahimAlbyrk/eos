import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonTtlStore } from "../genui/geo/JsonTtlStore.ts";
import { GeoServiceError, NominatimGeocoder, areaOf, type GeoFetch } from "../genui/geo/NominatimGeocoder.ts";
import { OverpassPlaceSearch, buildOverpassQuery, elementToPlace, formatDistance, overpassRegex } from "../genui/geo/OverpassPlaceSearch.ts";
import { PlaceSchema } from "../../../contracts/src/genui/catalog.ts";

const tmpFile = (name: string) => join(mkdtempSync(join(tmpdir(), "eos-geo-")), name);

function manualClock(start = 10_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("JsonTtlStore", () => {
  it("expires entries, caps the count, and persists", async () => {
    const clock = manualClock();
    const file = tmpFile("s.json");
    const store = new JsonTtlStore<number>({ file, clock, maxEntries: 2 });
    store.set("a", 1, 100);
    store.set("b", 2, 1000);
    store.set("c", 3, 1000);
    assert.equal(store.get("a"), undefined, "oldest dropped past the cap");
    assert.equal(store.get("b"), 2);
    await store.flush();
    const again = new JsonTtlStore<number>({ file, clock });
    assert.equal(again.get("c"), 3);
    clock.advance(1001);
    assert.equal(again.get("c"), undefined);
    assert.ok(JSON.parse(readFileSync(file, "utf8")).c);
  });
});

describe("NominatimGeocoder", () => {
  const SEARCH = [
    { lat: "40.9903", lon: "29.0290", display_name: "Moda, Kadıköy, İstanbul, Türkiye", type: "suburb", address: { suburb: "Moda", city_district: "Kadıköy", city: "İstanbul", country: "Türkiye" } },
    { lat: "x", lon: "1", display_name: "broken" },
  ];

  it("keeps one request per second and caches answers on disk", async () => {
    const clock = manualClock();
    const starts: number[] = [];
    const sleeps: number[] = [];
    const f: GeoFetch = async (url, init) => {
      starts.push(clock.now());
      assert.match(init.headers["user-agent"], /^Eos\//);
      return new Response(JSON.stringify(url.includes("/reverse") ? { address: { city: "Ankara", country: "Türkiye" } } : SEARCH), { status: 200 });
    };
    const geo = new NominatimGeocoder({
      store: new JsonTtlStore({ file: tmpFile("n.json"), clock }),
      clock,
      userAgent: "Eos/test",
      fetch: f,
      sleep: async (ms) => { sleeps.push(ms); clock.advance(ms); },
    });
    const [a, b, c] = await Promise.all([geo.search("Moda"), geo.search("Kadıköy"), geo.reverse(39.92077, 32.85411)]);
    assert.equal(a.length, 1, "unparseable rows dropped");
    assert.deepEqual(a[0], { lat: 40.9903, lon: 29.029, label: "Moda, Kadıköy, İstanbul, Türkiye", area: { district: "Moda", city: "İstanbul", country: "Türkiye" }, kind: "suburb" });
    assert.equal(b.length, 1);
    assert.deepEqual(c, { city: "Ankara", country: "Türkiye" });
    assert.deepEqual(starts, [10_000, 11_000, 12_000]);
    assert.deepEqual(sleeps, [1000, 1000]);
    await geo.search("  moda ");
    await geo.reverse(39.9209, 32.8540);
    assert.equal(starts.length, 3, "repeats come from the cache (reverse rounded to ~100 m)");
  });

  it("sends reverse coordinates rounded to three decimals", async () => {
    const clock = manualClock();
    let seen = "";
    const geo = new NominatimGeocoder({
      store: new JsonTtlStore({ file: tmpFile("n.json"), clock }),
      clock,
      userAgent: "Eos/test",
      fetch: async (url) => { seen = url; return new Response("{}", { status: 200 }); },
    });
    assert.equal(await geo.reverse(41.0082376, 28.9783589), null);
    assert.match(seen, /lat=41\.008&lon=28\.978/);
  });

  it("turns HTTP failures into a sentence", async () => {
    const clock = manualClock();
    const geo = new NominatimGeocoder({
      store: new JsonTtlStore({ file: tmpFile("n.json"), clock }),
      clock,
      userAgent: "Eos/test",
      fetch: async () => new Response("slow down", { status: 429 }),
    });
    await assert.rejects(geo.search("x"), (e: unknown) => e instanceof GeoServiceError && /rate limited/.test(e.message));
  });

  it("names the area from whichever address parts exist", () => {
    assert.deepEqual(areaOf({ town: "Bodrum", province: "Muğla", country: "Türkiye" }), { city: "Bodrum", country: "Türkiye" });
    assert.equal(areaOf({}), undefined);
  });
});

describe("Overpass", () => {
  const center = { lat: 40.99, lon: 29.03 };

  it("builds a named-feature query for a category, a query, or both", () => {
    const cat = buildOverpassQuery({ category: "cafe", center, radiusM: 800, limit: 10 });
    assert.match(cat, /^\[out:json\]\[timeout:20\];\(/);
    assert.match(cat, /nwr\(around:800,40\.990000,29\.030000\)\["amenity"~"\^cafe\$",i\]\["name"\];/);
    assert.match(cat, /out center tags 300;$/);
    const q = buildOverpassQuery({ query: "ramen", center, radiusM: 1500, limit: 10 });
    assert.match(q, /\["name"~"ramen",i\]\["amenity"\]/);
    assert.match(q, /\["cuisine"~"ramen",i\]\["name"\]/);
    const both = buildOverpassQuery({ query: "sushi", category: "restaurant", center, radiusM: 1500, limit: 10 });
    assert.match(both, /\["amenity"~"\^\(restaurant\|food_court\)\$",i\]\["name"~"sushi",i\]/);
    const odd = buildOverpassQuery({ category: "climbing gym", center, radiusM: 500, limit: 5 });
    assert.match(odd, /\["leisure"~"\^climbing_gym\$",i\]/);
  });

  it("escapes query text for the regex and the QL string", () => {
    assert.equal(overpassRegex('a.b"c'), 'a\\\\.b\\"c');
    assert.equal(overpassRegex("x\n]; out;"), "x \\\\]; out;");
  });

  it("maps an element to a valid Place", () => {
    const p = elementToPlace({
      type: "way",
      id: 123,
      center: { lat: 40.9912, lon: 29.0301 },
      tags: {
        name: "Çiya Sofrası", amenity: "restaurant", cuisine: "turkish;kebab", opening_hours: "Mo-Su 11:00-22:00",
        website: "https://www.ciya.com.tr/menu", "addr:street": "Güneşlibahçe Sk.", "addr:housenumber": "43", "addr:suburb": "Caferağa",
        outdoor_seating: "yes",
      },
    }, center);
    assert.ok(p);
    assert.equal(PlaceSchema.safeParse(p).success, true);
    assert.equal(p.id, "osm:way/123");
    assert.deepEqual(p.geo, [40.9912, 29.0301]);
    assert.equal(p.cuisine, "turkish, kebab");
    assert.deepEqual(p.hours, { text: "Mo-Su 11:00-22:00" });
    assert.equal(p.site, "ciya.com.tr");
    assert.equal(p.address, "Güneşlibahçe Sk. 43, Caferağa");
    assert.deepEqual(p.tags, ["outdoor seating"]);
    assert.equal(p.distance, "130 m");
    assert.equal(elementToPlace({ type: "node", id: 1, lat: 1, lon: 1, tags: {} }, center), null, "no name, no place");
  });

  it("drops an odd field instead of the place", () => {
    const p = elementToPlace({ type: "node", id: 9, lat: 41, lon: 29, tags: { name: "X", website: "not a url at all" } }, center);
    assert.ok(p);
    assert.equal(p.site, undefined);
  });

  it("searches, sorts nearest first, limits, and caches", async () => {
    const clock = manualClock();
    let calls = 0;
    const search = new OverpassPlaceSearch({
      store: new JsonTtlStore({ file: tmpFile("o.json"), clock }),
      userAgent: "Eos/test",
      fetch: async (_url, init) => {
        calls++;
        assert.match(decodeURIComponent(init.body), /^data=\[out:json\]/);
        return new Response(JSON.stringify({ elements: [
          { type: "node", id: 1, lat: 41.0, lon: 29.03, tags: { name: "Far", amenity: "cafe" } },
          { type: "node", id: 2, lat: 40.991, lon: 29.03, tags: { name: "Near", amenity: "cafe" } },
          { type: "node", id: 2, lat: 40.991, lon: 29.03, tags: { name: "Near", amenity: "cafe" } },
          { type: "node", id: 3, lat: 40.995, lon: 29.03, tags: { name: "Mid", amenity: "cafe" } },
        ] }), { status: 200 });
      },
    });
    const places = await search.search({ category: "cafe", center, radiusM: 2000, limit: 2 });
    assert.deepEqual(places.map((p) => p.name), ["Near", "Mid"]);
    await search.search({ category: "cafe", center, radiusM: 2000, limit: 2 });
    assert.equal(calls, 1);
  });

  it("formats distances", () => {
    assert.equal(formatDistance(3), "10 m");
    assert.equal(formatDistance(944), "940 m");
    assert.equal(formatDistance(1260), "1.3 km");
    assert.equal(formatDistance(12_400), "12 km");
  });
});
