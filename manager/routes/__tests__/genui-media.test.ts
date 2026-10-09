import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { Router, type RouteContext } from "../Router.ts";
import { registerGenuiMediaRoutes, type GenuiMediaRouteDeps } from "../genui-media.ts";
import { GeoServiceError } from "../../../infra/src/genui/geo/NominatimGeocoder.ts";
import { ValidationError } from "../../../core/src/errors/index.ts";

const UI = { "x-eos-ui-token": "tok" };
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

function deps() {
  const calls: Array<[string, unknown]> = [];
  const blob = { contentType: "image/png", body: PNG, etag: '"abc"', fetchedAt: 1 };
  const c: GenuiMediaRouteDeps = {
    uiToken: "tok",
    genuiMedia: {
      media: {
        image: async (src: string) => { calls.push(["image", src]); return src.includes("missing") ? null : blob; },
        og: async (url: string) => { calls.push(["og", url]); return blob; },
        icon: async (site: string) => { calls.push(["icon", site]); return { ...blob, contentType: "image/svg+xml" }; },
      },
      map: {
        style: async () => ({ status: 200, contentType: "application/json", body: Buffer.from('{"version":8}'), cacheControl: "private, max-age=3600" }),
        get: async (path: string) => {
          calls.push(["map", path]);
          return { status: 200, contentType: path.endsWith(".pbf") ? "application/x-protobuf" : "text/html", body: Buffer.from("x"), cacheControl: "private" };
        },
      },
      geocoder: {
        search: async (q: string, limit?: number) => {
          calls.push(["geocode", { q, limit }]);
          if (q === "down") throw new GeoServiceError("OpenStreetMap geocoding answered 503");
          return q === "nowhere" ? [] : [{ lat: 40.99, lon: 29.03, label: "Moda, İstanbul" }];
        },
      },
      places: {
        search: async (q: unknown) => { calls.push(["places", q]); return [{ id: "osm:node/1", type: "Place", name: "Café" }]; },
      },
    } as unknown as GenuiMediaRouteDeps["genuiMedia"],
  };
  return { c, calls };
}

async function call(c: GenuiMediaRouteDeps, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
  const router = new Router();
  registerGenuiMediaRoutes(router, c);
  const u = new URL(`http://x${path}`);
  const m = router.match(method, u.pathname);
  assert.ok(m, `no ${method} route for ${u.pathname}`);
  const headers = opts.headers ?? {};
  const req = Object.assign(Readable.from([JSON.stringify(opts.body ?? {})]), { headers, method }) as unknown as RouteContext["req"];
  let status = 0;
  let sent: Record<string, unknown> = {};
  let raw: Buffer | string | undefined;
  const set: Record<string, unknown> = {};
  const res = {
    req: { method, headers },
    setHeader: (k: string, v: unknown) => { set[k] = v; },
    getHeader: (k: string) => set[k],
    writeHead: (s: number, h?: Record<string, unknown>) => { status = s; sent = { ...set, ...(h ?? {}) }; },
    end: (b?: Buffer | string) => { raw = b; },
  } as unknown as RouteContext["res"];
  await m.handler({ params: m.params, url: u, req, res, method, path: u.pathname } as RouteContext);
  const json = typeof raw === "string" && raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  return { status, headers: sent, raw, json };
}

describe("genui media routes", () => {
  it("refuse every media and map request without the ui token", async () => {
    const { c, calls } = deps();
    for (const p of ["/api/genui/media/img?src=https://a.example/x.png", "/api/genui/media/og?url=https://a.example/", "/api/genui/media/icon?site=a.example", "/api/genui/map/style.json", "/api/genui/map/t/planet"]) {
      assert.equal((await call(c, "GET", p)).status, 403, p);
      assert.equal((await call(c, "GET", p, { headers: { "x-eos-ui-token": "nope" } })).status, 403, p);
    }
    assert.equal(calls.length, 0);
  });

  it("refuse a frame or window navigated to the proxy, even with the token", async () => {
    const { c, calls } = deps();
    for (const dest of ["document", "iframe", "frame", "embed", "object"]) {
      const r = await call(c, "GET", "/api/genui/media/img?src=https://a.example/x.png", { headers: { ...UI, "sec-fetch-dest": dest } });
      assert.equal(r.status, 403, dest);
    }
    assert.equal((await call(c, "GET", "/api/genui/map/t/planet", { headers: { ...UI, "sec-fetch-dest": "iframe" } })).status, 403);
    assert.equal(calls.length, 0);
    for (const dest of ["image", "empty", "worker"]) {
      const r = await call(c, "GET", "/api/genui/media/img?src=https://a.example/x.png", { headers: { ...UI, "sec-fetch-dest": dest } });
      assert.equal(r.status, 200, dest);
    }
  });

  it("serve image bytes inert, cacheable and revalidatable", async () => {
    const { c, calls } = deps();
    const r = await call(c, "GET", "/api/genui/media/img?src=https%3A%2F%2Fcdn.example%2Fa.png", { headers: UI });
    assert.equal(r.status, 200);
    assert.deepEqual(r.raw, PNG);
    assert.equal(r.headers["content-type"], "image/png");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.match(String(r.headers["content-security-policy"]), /sandbox/);
    assert.match(String(r.headers["cache-control"]), /^private, max-age=\d+/);
    assert.deepEqual(calls, [["image", "https://cdn.example/a.png"]]);
    const again = await call(c, "GET", "/api/genui/media/img?src=https%3A%2F%2Fcdn.example%2Fa.png", { headers: { ...UI, "if-none-match": '"abc"' } });
    assert.equal(again.status, 304);
  });

  it("404 when nothing resolves, and validate the query", async () => {
    const { c } = deps();
    const miss = await call(c, "GET", "/api/genui/media/img?src=https://cdn.example/missing.png", { headers: UI });
    assert.equal(miss.status, 404);
    await assert.rejects(call(c, "GET", "/api/genui/media/img?src=not-a-url", { headers: UI }), ValidationError);
    await assert.rejects(call(c, "GET", "/api/genui/media/icon", { headers: UI }), ValidationError);
    const svg = await call(c, "GET", "/api/genui/media/icon?site=acme.example", { headers: UI });
    assert.equal(svg.headers["content-type"], "image/svg+xml");
  });

  it("proxy map tiles, never serving an active type", async () => {
    const { c, calls } = deps();
    const tile = await call(c, "GET", "/api/genui/map/t/planet/v1/1/0/0.pbf", { headers: UI });
    assert.equal(tile.headers["content-type"], "application/x-protobuf");
    const odd = await call(c, "GET", "/api/genui/map/t/weird", { headers: UI });
    assert.equal(odd.headers["content-type"], "application/octet-stream");
    assert.deepEqual(calls.map(([k, v]) => `${k}:${String(v)}`), ["map:planet/v1/1/0/0.pbf", "map:weird"]);
    const style = await call(c, "GET", "/api/genui/map/style.json", { headers: UI });
    assert.equal(style.status, 200);
  });

  it("geocode without the ui token, with attribution", async () => {
    const { c } = deps();
    const r = await call(c, "GET", "/api/genui/geocode?q=Moda&limit=2");
    assert.equal(r.status, 200);
    assert.match(String(r.json?.attribution), /OpenStreetMap/);
    assert.equal((r.json?.results as unknown[]).length, 1);
    assert.equal((await call(c, "GET", "/api/genui/geocode?q=down")).status, 502);
  });

  it("search places near a point or a geocoded name", async () => {
    const { c, calls } = deps();
    const byPoint = await call(c, "POST", "/api/genui/places", { body: { category: "cafe", near: { lat: 41, lon: 29 } } });
    assert.equal(byPoint.status, 200);
    assert.deepEqual(calls.at(-1), ["places", { query: undefined, category: "cafe", center: { lat: 41, lon: 29 }, radiusM: 1500, limit: 12 }]);
    const byName = await call(c, "POST", "/api/genui/places", { body: { query: "ramen", near: { text: "Moda" }, radiusM: 800, limit: 5 } });
    assert.equal(byName.status, 200);
    assert.deepEqual(byName.json?.center, { lat: 40.99, lon: 29.03, label: "Moda, İstanbul" });
    const lost = await call(c, "POST", "/api/genui/places", { body: { query: "x", near: { text: "nowhere" } } });
    assert.equal(lost.status, 404);
    assert.match(String(lost.json?.error), /Couldn't find "nowhere"/);
    await assert.rejects(call(c, "POST", "/api/genui/places", { body: { near: { lat: 1, lon: 1 } } }), ValidationError);
  });
});
