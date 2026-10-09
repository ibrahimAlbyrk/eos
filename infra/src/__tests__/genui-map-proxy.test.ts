import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MAP_ATTRIBUTION, OpenFreeMapProxy, rewriteMapUrls, upstreamUrl, type MapFetch } from "../genui/OpenFreeMapProxy.ts";

const STYLE = {
  version: 8,
  sources: {
    openmaptiles: { type: "vector", url: "https://tiles.openfreemap.org/planet" },
    ne2_shaded: { type: "raster", tiles: ["https://tiles.openfreemap.org/natural_earth/ne2sr/{z}/{x}/{y}.png"], maxzoom: 6 },
  },
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sprite: "https://tiles.openfreemap.org/sprites/ofm_f384/ofm",
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#101010" }, metadata: { link: "https://openmaptiles.org" } }],
};

function fakeFetch(routes: Record<string, { status?: number; type?: string; body: string | Buffer; location?: string }>) {
  const calls: string[] = [];
  const f: MapFetch = async (url) => {
    calls.push(url);
    const r = routes[url];
    if (!r) return new Response("missing", { status: 404 });
    const headers: Record<string, string> = { "content-type": r.type ?? "application/json" };
    if (r.location) headers.location = r.location;
    return new Response(typeof r.body === "string" ? r.body : new Uint8Array(r.body), { status: r.status ?? 200, headers });
  };
  return { f, calls };
}

describe("rewriteMapUrls", () => {
  it("points every OpenFreeMap URL at the proxy and leaves the rest alone", () => {
    const out = rewriteMapUrls(STYLE) as typeof STYLE;
    assert.equal(out.sources.openmaptiles.url, "/api/genui/map/t/planet");
    assert.deepEqual(out.sources.ne2_shaded.tiles, ["/api/genui/map/t/natural_earth/ne2sr/{z}/{x}/{y}.png"]);
    assert.equal(out.glyphs, "/api/genui/map/t/fonts/{fontstack}/{range}.pbf");
    assert.equal(out.sprite, "/api/genui/map/t/sprites/ofm_f384/ofm");
    assert.equal(out.layers[0].metadata.link, "https://openmaptiles.org");
    assert.equal(rewriteMapUrls("https://tiles.openfreemap.org.evil.com/x"), "https://tiles.openfreemap.org.evil.com/x");
  });
});

describe("upstreamUrl", () => {
  it("maps proxy paths onto OpenFreeMap only", () => {
    assert.equal(upstreamUrl("planet/20250101_001001_pt/14/9000/6000.pbf"), "https://tiles.openfreemap.org/planet/20250101_001001_pt/14/9000/6000.pbf");
    assert.equal(upstreamUrl("fonts/Noto%20Sans%20Regular/0-255.pbf"), "https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf");
    assert.equal(upstreamUrl("sprites/ofm_f384/ofm@2x.json"), "https://tiles.openfreemap.org/sprites/ofm_f384/ofm@2x.json");
    for (const bad of ["../etc", "a/../../b", "%2e%2e/x", "/evil.com/x", "//evil.com/x", "http://evil.com/", "a\\b", "a?x=1", "", "a#b"]) {
      assert.equal(upstreamUrl(bad), null, bad);
    }
  });
});

describe("OpenFreeMapProxy", () => {
  it("serves the dark style rewritten, with attribution, cached for an hour", async () => {
    let now = 0;
    const { f, calls } = fakeFetch({ "https://tiles.openfreemap.org/styles/dark": { body: JSON.stringify(STYLE) } });
    const proxy = new OpenFreeMapProxy({ userAgent: "Eos/test", now: () => now, fetch: f });
    const res = await proxy.style();
    assert.equal(res.status, 200);
    const style = JSON.parse(res.body.toString());
    assert.equal(style.glyphs, "/api/genui/map/t/fonts/{fontstack}/{range}.pbf");
    assert.equal(style.metadata["eos:attribution"], MAP_ATTRIBUTION);
    await proxy.style();
    assert.equal(calls.length, 1);
    now += 60 * 60 * 1000 + 1;
    await proxy.style();
    assert.equal(calls.length, 2);
  });

  it("rewrites TileJSON and passes tiles through untouched", async () => {
    const tile = Buffer.from([0x1a, 0x02, 0x00, 0x01]);
    const { f } = fakeFetch({
      "https://tiles.openfreemap.org/planet": { body: JSON.stringify({ tiles: ["https://tiles.openfreemap.org/planet/v1/{z}/{x}/{y}.pbf"] }) },
      "https://tiles.openfreemap.org/planet/v1/1/0/0.pbf": { type: "application/x-protobuf", body: tile },
    });
    const proxy = new OpenFreeMapProxy({ userAgent: "Eos/test", now: () => 0, fetch: f });
    const tj = JSON.parse((await proxy.get("planet")).body.toString());
    assert.deepEqual(tj.tiles, ["/api/genui/map/t/planet/v1/{z}/{x}/{y}.pbf"]);
    const t = await proxy.get("planet/v1/1/0/0.pbf");
    assert.equal(t.contentType, "application/x-protobuf");
    assert.deepEqual(t.body, tile);
    assert.match(t.cacheControl, /private/);
  });

  it("never follows a redirect off OpenFreeMap and reports upstream failures", async () => {
    const { f, calls } = fakeFetch({
      "https://tiles.openfreemap.org/planet/x.pbf": { status: 302, body: "", location: "https://evil.example/x.pbf" },
      "https://tiles.openfreemap.org/planet/err.pbf": { status: 500, body: "" },
    });
    const proxy = new OpenFreeMapProxy({ userAgent: "Eos/test", now: () => 0, fetch: f });
    assert.equal((await proxy.get("planet/x.pbf")).status, 502);
    assert.equal((await proxy.get("planet/err.pbf")).status, 502);
    assert.equal((await proxy.get("planet/none.pbf")).status, 404);
    assert.equal((await proxy.get("../secret")).status, 404);
    assert.ok(!calls.some((u) => !u.startsWith("https://tiles.openfreemap.org/")));
  });
});
