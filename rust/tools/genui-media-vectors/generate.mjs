#!/usr/bin/env node
// Writes rust/fixtures/genui-media/vectors.json: what today's TypeScript
// computes in the visual-answer media and geo adapters (infra/src/genui), for
// crates/eos-genui-media. No network: every fetch is a stub.
//
//   node rust/tools/genui-media-vectors/generate.mjs            write
//   node rust/tools/genui-media-vectors/generate.mjs --check    fail when it would change
//
// Needs Node ≥ 23.6 and `npm ci` in contracts/.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const OUT = path.join(REPO, "rust/fixtures/genui-media/vectors.json");
const load = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

const meta = await load("infra/src/genui/html-meta.ts");
const media = await load("infra/src/genui/GenuiMedia.ts");
const cache = await load("infra/src/genui/MediaCache.ts");
const map = await load("infra/src/genui/OpenFreeMapProxy.ts");
const nominatim = await load("infra/src/genui/geo/NominatimGeocoder.ts");
const overpass = await load("infra/src/genui/geo/OverpassPlaceSearch.ts");

// ---- pages ------------------------------------------------------------------

const PAGES = [
  ["https://example.com/a/b.html", `<html><head><meta property="og:image" content="/img/og.png"><meta name="twitter:image" content="https://cdn.example.com/tw.png"></head></html>`],
  ["https://example.com/a/b.html", `<head><meta property="og:image:secure_url" content="https://s.example.com/secure.png"><meta property="og:image" content="http://example.com/plain.png"></head>`],
  ["https://example.com/a/", `<head><meta name="twitter:image:src" content="tw.jpg"><link rel="image_src" href="link.png"></head>`],
  ["https://example.com/", `<head><link rel="image_src" href="//cdn.example.com/x.png"></head><body><meta property="og:image" content="/late.png"></body>`],
  ["https://example.com/", `<meta content="https://example.com/a.png?x=1&amp;y=2" property="OG:IMAGE">`],
  ["https://example.com/", `<meta property=og:image content=/unquoted.png>`],
  ["https://example.com/", `<meta property='og:image' content='  /spaced.png  '>`],
  ["https://example.com/", `<meta itemprop="image" content="item.png">`],
  ["https://example.com/", `<meta property="og:image" content="javascript:alert(1)"><meta name="twitter:image" content="data:image/png;base64,AA"><meta name="image" content="ftp://example.com/a.png">`],
  ["https://example.com/", `<meta property="og:image" content="">`],
  ["https://example.com/", `<p>no head at all</p>`],
  ["https://example.com/dir/page", `<HEAD><META PROPERTY="og:image:url" CONTENT="../up.png"></HEAD>`],
  ["https://example.com/", `<head><meta property="og:image" content="https://example.com/q&quot;uote&#39;s&#x2F;x&lt;y&unknown;.png"></head>`],
  ["https://example.com/", `<head><meta property="og:image" content="https://exa mple.com/bad host.png"><meta name="twitter:image" content="/second.png"></head>`],
  ["https://example.com/", `<head><meta property="og:image" content="/İstanbul/kadıköy.png"></head>`],
  ["not a url", `<meta property="og:image" content="/x.png">`],
  ["https://example.com/", `<head><link rel="apple-touch-icon" sizes="180x180" href="/apple-180.png"><link rel="apple-touch-icon" sizes="120x120" href="/apple-120.png"><link rel="icon" type="image/svg+xml" href="/icon.svg"><link rel="icon" sizes="32x32" href="/favicon-32.png"><link rel="shortcut icon" href="/favicon.ico"></head>`],
  ["https://example.com/sub/", `<head><link rel="icon" sizes="16x16 48x48" href="multi.ico"><link rel="ICON" sizes="any" href="any.png"><link rel="apple-touch-icon-precomposed" href="pre.png"><link rel="mask-icon" href="mask.svg"><link rel="stylesheet" href="a.css"></head>`],
  ["https://example.com/", `<head><link rel="icon" href="/a.svg?v=2"><link rel="icon" href="/b.png" sizes="64X64"><link href="/c.png" rel="alternate icon"></head>`],
  ["https://example.com/", ``],
  ["https://www.example.com/deep/path?q=1", `<head><link rel="icon" href="mailto:x@example.com"><link rel="icon"></head>`],
];
const pages = PAGES.map(([url, html]) => {
  let icons;
  try {
    icons = meta.extractIcons(html, url);
  } catch (e) {
    icons = { throws: e instanceof Error ? e.name : String(e) };
  }
  return { url, html, preview: meta.extractPreviewImage(html, url), icons };
});

const SITES = ["Example.com", "https://www.example.com/a", " example.com. ", "http://EXAMPLE.co.uk:8080/x", "localhost", "127.0.0.1", "exa mple.com", "", "a".repeat(254), "xn--mnchen-3ya.de", "münchen.de", "foo.xn--p1ai", "-bad.example.com", "ftp://files.example.org/x", "example.c", "sub.domain.example.museum", "user:pw@example.com", "[::1]", "example.com/path?x#y", "EXAMPLE.COM:443"];
const sites = SITES.map((site) => ({ site, host: meta.normalizeSite(site) }));

// ---- images -----------------------------------------------------------------

const hex = (s) => Buffer.from(s, "hex");
const text = (s) => Buffer.from(s, "utf8");
const BODIES = [
  hex("89504e470d0a1a0a0000000d"),
  hex("ffd8ffe000104a464946"),
  text("GIF89a......"),
  text("GIF87a......"),
  text("GIF88a......"),
  Buffer.concat([text("RIFF"), hex("00000000"), text("WEBPVP8 ")]),
  Buffer.concat([hex("00000020"), text("ftypavif"), hex("00000000")]),
  Buffer.concat([hex("00000020"), text("ftypavis"), hex("00000000")]),
  Buffer.concat([hex("00000020"), text("ftypheic"), hex("00000000")]),
  hex("000001000100101000000100"),
  text("BM......"),
  text(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`),
  text(`﻿  <?xml version="1.0"?>\n<!-- c --><!DOCTYPE svg PUBLIC "x" "y">\n<svg width="1">`),
  text(`<?xml version="1.0"?><html><svg></svg></html>`),
  text(`<svgx>`),
  text(`<SVG\n>`),
  text(`<!doctype html><html></html>`),
  text(""),
  hex("8950"),
  text(" ".repeat(1100) + "<svg>"),
];
const images = BODIES.map((body) => ({
  hex: body.toString("hex"),
  sniffed: media.sniffImageType(body),
  asOctetStream: media.imageTypeOf("application/octet-stream", body),
  asDeclaredPng: media.imageTypeOf("image/png", body),
}));
const TYPES = ["", "image/png", "image/svg+xml", "application/octet-stream", "binary/octet-stream", "application/binary", "application/unknown", "text/html", "application/json", "imagex/png"];
const imageish = TYPES.map((type) => ({ type, ok: media.isImageish(type) }));

const etags = [];
for (const body of [BODIES[0], BODIES[1], text("hello")]) {
  const stub = { get: async () => null, put: async () => {} };
  const m = new media.GenuiMedia({ cache: stub, clock: { now: () => 7 }, userAgent: "x", safeGet: async (url) => ({ url, status: 200, contentType: "image/png", headers: {}, body }) });
  const blob = await m.image("https://example.com/a.png");
  etags.push({ hex: body.toString("hex"), etag: blob.etag });
}

const cacheKeys = [["img", "https://example.com/a.png"], ["og", "https://example.com/"], ["icon", "example.com"], ["img", "https://example.com/ü?x=1&y=2"]].map(([namespace, url]) => ({ namespace, url, key: cache.cacheKey(namespace, url) }));

// What MediaCache writes beside a blob: the meta file's exact text.
const metaFiles = [
  { meta: { url: "https://example.com/a.png", kind: "blob", contentType: "image/png", size: 0, fetchedAt: 1700000000000 }, bodyLength: 11 },
  { meta: { url: "example.com", kind: "ref", contentType: "", size: 0, fetchedAt: 5, ref: "https://example.com/favicon.ico" }, bodyLength: null },
  { meta: { url: "https://example.com/x", kind: "miss", contentType: "", size: 0, fetchedAt: 9, reason: "the server answered 404" }, bodyLength: null },
].map(({ meta: m, bodyLength }) => ({ meta: m, bodyLength, json: JSON.stringify({ ...m, size: bodyLength ?? 0 }) }));

// ---- map --------------------------------------------------------------------

const STYLE = {
  version: 8,
  name: "dark",
  metadata: { "maputnik:renderer": "mbgljs" },
  sources: { openmaptiles: { type: "vector", url: "https://tiles.openfreemap.org/planet" }, other: { type: "raster", tiles: ["https://tile.example.org/{z}/{x}/{y}.png"] } },
  sprite: "https://tiles.openfreemap.org/sprites/ofm_f384/ofm",
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#000" } }, null, 3, true, "https://tiles.openfreemap.org", "https://tiles.openfreemap.org/"],
  "10": "index-like key",
  "2": "https://tiles.openfreemap.org/x",
};
const rewrites = [STYLE, "https://tiles.openfreemap.org/a/b", "https://tiles.openfreemap.org.evil.example/a", ["https://tiles.openfreemap.org/t/{z}/{x}/{y}.pbf"], { tiles: ["https://tiles.openfreemap.org/planet/20250101_001001_pt/{z}/{x}/{y}.pbf"], n: 1.5 }]
  .map((value) => ({ value, json: JSON.stringify(map.rewriteMapUrls(value)) }));
// The style as the proxy serves it (rewritten, with the attribution).
let styleServed;
{
  const proxy = new map.OpenFreeMapProxy({ userAgent: "x", now: () => 0, fetch: async () => new Response(JSON.stringify(STYLE), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }) });
  const res = await proxy.style();
  styleServed = { upstream: JSON.stringify(STYLE), status: res.status, contentType: res.contentType, cacheControl: res.cacheControl, body: res.body.toString("utf8") };
}
const PATHS = ["planet", "styles/dark", "planet/20250101_001001_pt/14/8192/5461.pbf", "fonts/Noto Sans Regular/0-255.pbf", "fonts/Noto%20Sans%20Regular,Noto%20Sans%20Bold/0-255.pbf", "fonts/{fontstack}/{range}.pbf", "sprites/ofm_f384/ofm@2x.png", "", "/abs", "//evil.example/x", "../up", "a/../b", "a/./b", "a/%2e%2e/b", "a\\b", "a?b=1", "a#b", "https://evil.example/x", "a/%zz", "x".repeat(513), "x".repeat(512), "a/..b", "a b/c", ".hidden", "a/%2Fb", "%2Fabs", "tiles/ü.pbf", "a/b/"];
const upstream = PATHS.map((p) => ({ path: p, url: map.upstreamUrl(p) }));

// ---- geocoding --------------------------------------------------------------

const ADDRESSES = [
  undefined,
  {},
  { suburb: "Moda", city: "İstanbul", country: "Türkiye", country_code: "tr" },
  { city_district: "Kadıköy", town: "X", country: "Y" },
  { neighbourhood: " Caferağa ", village: "V" },
  { quarter: "Q", municipality: "M" },
  { borough: "B", county: "C" },
  { district: "D", province: "P" },
  { state: "S" },
  { suburb: "  ", city: "", country: "Z" },
  { road: "Only a road" },
];
const areas = ADDRESSES.map((address) => ({ address: address ?? null, area: nominatim.areaOf(address) ?? null }));
const NOMINATIM = [
  { lat: "40.9876", lon: "29.0321", display_name: "Moda, Kadıköy, İstanbul, Türkiye", name: "Moda", type: "suburb", addresstype: "suburb", address: { suburb: "Moda", city: "İstanbul", country: "Türkiye" } },
  { lat: "40.5", lon: "29", name: "Just a name", addresstype: "place" },
  { lat: "1.123456789", lon: "-2.987654321" },
  { lat: "91", lon: "0", display_name: "off the globe" },
  { lat: "0", lon: "-181", display_name: "off the globe" },
  { lat: "abc", lon: "1" },
  { lon: "1" },
  { lat: "", lon: "" },
  { lat: "-0", lon: "1e1", display_name: "", name: "" },
  { lat: " 12.5 ", lon: "0x10", type: "", addresstype: "road" },
];
const geocodeResults = NOMINATIM.map((place) => ({ place, result: nominatim.toGeocodeResult(place) }));

const geocodeCalls = [];
{
  const urls = [];
  const store = { get: () => undefined, set: () => {} };
  const g = new nominatim.NominatimGeocoder({ store, clock: { now: () => 0 }, userAgent: "x", sleep: async () => {}, minIntervalMs: 0, fetch: async (url) => { urls.push(url); return new Response(url.includes("/reverse") ? "{}" : "[]", { status: 200 }); } });
  for (const [q, limit] of [["Moda", 5], ["  Kadıköy   Moda, İstanbul ", 1], ["a&b=c d", 99], ["x", 0], ["x", 2.9], ["   ", 5]]) {
    urls.length = 0;
    await g.search(q, limit);
    geocodeCalls.push({ search: q, limit, url: urls[0] ?? null });
  }
  for (const [lat, lon] of [[40.98765, 29.03219], [-0.0004, 179.9996], [5, -5], [1.0005, 2.0015], [12.3455, -12.3455]]) {
    urls.length = 0;
    await g.reverse(lat, lon);
    geocodeCalls.push({ reverse: [lat, lon], url: urls[0] ?? null });
  }
}

// ---- places -----------------------------------------------------------------

const REGEX = ["ramen", "a.b*c", "what? (yes) [no] {1} ^$ | +", `back\\slash "quoted"`, "tab\tnew\nline", "İstanbul kahve", "50%", "a/b"];
const regexes = REGEX.map((t) => ({ text: t, regex: overpass.overpassRegex(t) }));
const center = { lat: 40.9876, lon: 29.0321 };
const QUERIES = [
  { category: "cafe" },
  { category: "Cafes" },
  { category: "coffee" },
  { category: "  Ice   Cream " },
  { category: "bike repair" },
  { category: "sushi.bar" },
  { query: "ramen" },
  { query: "Moda Kıyı" },
  { query: `the "best" (really)` },
  { query: "ramen", category: "restaurant" },
  { query: "espresso", category: "coffee" },
  { query: "x", category: "bookstores" },
  { query: "  ", category: "sights" },
  { category: "glass" },
].map((q) => ({ ...q, center, radiusM: 1500, limit: 12 }));
QUERIES.push({ category: "atm", center: { lat: -33.8688197, lon: 151.2092955 }, radiusM: 249.5, limit: 3 });
QUERIES.push({ category: "atm", center: { lat: 1, lon: 2 }, radiusM: 50, limit: 3 });
const queries = QUERIES.map((q) => ({ q, ql: overpass.buildOverpassQuery(q) }));

const DIST = [[center, center], [center, { lat: 40.99, lon: 29.03 }], [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }], [{ lat: 89.9, lon: 0 }, { lat: 89.9, lon: 180 }], [{ lat: -33.8688, lon: 151.2093 }, { lat: 51.5074, lon: -0.1278 }]];
const distances = DIST.map(([a, b]) => ({ a, b, m: overpass.distanceM(a, b) }));
const METERS = [0, 4, 5, 14.9, 15, 944.9, 945, 949.9, 950, 999, 1000, 1049, 1050, 9949, 9950, 9951, 10499, 10500, 123456];
const formatted = METERS.map((m) => ({ m, text: overpass.formatDistance(m) }));

const ELEMENTS = [
  { type: "node", id: 1, lat: 40.98801, lon: 29.03301, tags: { name: "Bean", amenity: "cafe", cuisine: "coffee_shop;breakfast", opening_hours: "Mo-Su 08:00-22:00", website: "https://www.bean.example/menu", "addr:street": "Moda Cd.", "addr:housenumber": "12", "addr:suburb": "Moda", outdoor_seating: "yes", internet_access: "wlan", phone: "+90 216 000 00 00" } },
  { type: "way", id: 22, center: { lat: 40.9912345678, lon: 29.0298765432 }, tags: { name: "Roast", shop: "coffee", opening_hours: "24/7", "contact:website": "roast.example", takeaway: "only", "diet:vegan": "yes", "diet:vegetarian": "only", delivery: "yes", wheelchair: "yes" } },
  { type: "relation", id: 333, center: { lat: 40.98, lon: 29.04 }, tags: { name: "Old Market", amenity: "marketplace", opening_hours: "closed", url: "not a url at all", "addr:place": "Çarşı", "addr:city": "İstanbul" } },
  { type: "node", id: 4, lat: 40.99, lon: 29.03, tags: { name: "Odd Site", tourism: "museum", website: "ftp://files.example/x;https://second.example", "contact:phone": "1".repeat(60), opening_hours: "off" } },
  { type: "node", id: 5, lat: 40.99, lon: 29.03, tags: { name: "N".repeat(250), leisure: "park", cuisine: " ; ;", opening_hours: "x".repeat(120), website: "https://exämple.com/" } },
  { type: "node", id: 6, lat: 40.99, lon: 29.03, tags: { amenity: "cafe" } },
  { type: "node", id: 7, tags: { name: "No position" } },
  { id: 8, lat: 1, lon: 2, tags: { name: "No type" } },
  { type: "node", lat: 1, lon: 2, tags: { name: "No id" } },
  { type: "node", id: 9, lat: 40.99, lon: 29.03, tags: { name: "Historic", historic: "castle", website: "https://localhost/", "addr:district": "D" } },
  { type: "node", id: 10, lat: 40.99, lon: 29.03, tags: { name: "Long site", amenity: "fast_food", website: "https://example.com/" + "a".repeat(2100) } },
  { type: "node", id: 11, lat: 95, lon: 29.03, tags: { name: "Off the globe", amenity: "bar" } },
  { type: "node", id: 12, lat: 40.99, lon: 29.03, tags: { name: "   ", amenity: "bar" } },
  { type: "node", id: 0, lat: 40.987612349, lon: 29.032149999, tags: { name: "Zero id", shop: "department_store", "addr:housenumber": "7" } },
];
const elements = ELEMENTS.map((el) => ({ el, place: overpass.elementToPlace(el, center) }));

const searches = [];
{
  const bodies = [];
  const store = { get: () => undefined, set: () => {} };
  const all = [...ELEMENTS, ELEMENTS[0], { type: "node", id: 99, lat: 41.2, lon: 29.3, tags: { name: "Far away", amenity: "cafe" } }, { type: "node", id: 98, lat: 40.9876 + 0.01395, lon: 29.0321, tags: { name: "Just outside the radius", amenity: "cafe" } }];
  const s = new overpass.OverpassPlaceSearch({ store, userAgent: "x", fetch: async (_url, init) => { bodies.push(init.body); return new Response(JSON.stringify({ elements: all }), { status: 200 }); } });
  for (const q of [{ category: "cafe", center, radiusM: 1500, limit: 12 }, { query: "bean", center, radiusM: 1500, limit: 2 }, { category: "cafe", center, radiusM: 120, limit: 12 }]) {
    bodies.length = 0;
    const places = await s.search(q);
    searches.push({ q, elements: all, body: bodies[0], places });
  }
}

const vectors = { pages, sites, images, imageish, etags, cacheKeys, metaFiles, rewrites, styleServed, upstream, areas, geocodeResults, geocodeCalls, regexes, queries, distances, formatted, elements, searches };
const json = `${JSON.stringify(vectors, null, 1)}\n`;
if (process.argv.includes("--check")) {
  if (!existsSync(OUT) || readFileSync(OUT, "utf8") !== json) {
    console.error("rust/fixtures/genui-media/vectors.json is stale: run node rust/tools/genui-media-vectors/generate.mjs");
    process.exit(1);
  }
  console.log("genui-media vectors are current");
} else {
  writeFileSync(OUT, json);
  console.log(`wrote ${path.relative(REPO, OUT)} (${Object.entries(vectors).map(([k, v]) => `${k} ${Array.isArray(v) ? v.length : 1}`).join(", ")})`);
}
