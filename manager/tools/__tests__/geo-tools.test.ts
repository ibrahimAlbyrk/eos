import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { findPlacesDef } from "../defs/find_places.ts";
import { currentLocationDef } from "../defs/current_location.ts";
import type { ToolContext } from "../types.ts";

type Route = (body: unknown) => unknown;

function ctxWith(routes: Record<string, Route>) {
  const calls: Array<[string, string, unknown]> = [];
  const ctx: ToolContext = {
    selfId: "orch-1",
    cwd: "/repo",
    isGitRepo: () => true,
    api: async (method, path, body) => {
      calls.push([method, path, body]);
      const r = routes[`${method} ${path}`];
      if (!r) throw new Error(`daemon 404: {"error":"not found"}`);
      return r(body);
    },
  };
  return { ctx, calls };
}

const refuse = (status: number, error: string): Route => () => { throw new Error(`daemon ${status}: ${JSON.stringify({ error, code: "x" })}`); };
const PLACES = {
  places: [{ id: "osm:node/1", type: "Place", name: "Kahve Dünyası", geo: [40.99, 29.03], distance: "120 m" }],
  attribution: "© OpenStreetMap contributors (ODbL)",
  center: { lat: 40.99, lon: 29.03, label: "Moda, Kadıköy, İstanbul" },
  radiusM: 1500,
};
const HERE = { lat: 40.9876, lon: 29.0234, accuracy: 35.4, at: Date.now() - 5000, area: { district: "Kadıköy", city: "İstanbul", country: "Türkiye" } };

describe("find_places", () => {
  it("searches near a named place and returns Place entities as JSON", async () => {
    const { ctx, calls } = ctxWith({ "POST /api/genui/places": () => PLACES });
    const out = String(await findPlacesDef.handler(ctx, { category: "cafe", near: { text: "Moda" }, radiusM: 99_999, limit: 0 }));
    assert.deepEqual(calls[0], ["POST", "/api/genui/places", { category: "cafe", near: { text: "Moda" }, radiusM: 20_000, limit: 1 }]);
    const [head, json] = out.split("\n");
    assert.match(head, /^1 place for cafe within 1\.5 km of Moda, Kadıköy, İstanbul/);
    assert.match(head, /OpenStreetMap/);
    const parsed = JSON.parse(json);
    assert.equal(parsed.places[0].id, "osm:node/1");
    assert.equal(parsed.source.site, "openstreetmap.org");
  });

  it("accepts a plain string or a point for near", async () => {
    const { ctx, calls } = ctxWith({ "POST /api/genui/places": () => PLACES });
    await findPlacesDef.handler(ctx, { query: "ramen", near: "Kadıköy" });
    await findPlacesDef.handler(ctx, { query: "ramen", near: { lat: 41, lon: 29 } });
    assert.deepEqual(calls.map((c) => (c[2] as { near: unknown }).near), [{ text: "Kadıköy" }, { lat: 41, lon: 29 }]);
  });

  it("falls back to the user's location when no place is given", async () => {
    const { ctx, calls } = ctxWith({ "GET /api/location": () => HERE, "POST /api/genui/places": () => ({ ...PLACES, center: { lat: HERE.lat, lon: HERE.lon } }) });
    const out = String(await findPlacesDef.handler(ctx, { query: "pharmacy" }));
    assert.deepEqual((calls[1][2] as { near: unknown }).near, { lat: HERE.lat, lon: HERE.lon });
    assert.match(out, /of the user \(Kadıköy, İstanbul, Türkiye\)/);
  });

  it("explains a missing location instead of guessing", async () => {
    const { ctx } = ctxWith({ "GET /api/location": refuse(403, "Location sharing is off. The user can turn it on in Settings › General › Visual answers.") });
    await assert.rejects(findPlacesDef.handler(ctx, { category: "bar" }), /location isn't available: Location sharing is off\. .* Ask the user where to search/);
  });

  it("needs a query or a category and a real point", async () => {
    const { ctx } = ctxWith({});
    await assert.rejects(findPlacesDef.handler(ctx, { near: "Moda" }), /needs a query or a category/);
    await assert.rejects(findPlacesDef.handler(ctx, { query: "x", near: { lat: 200, lon: 0 } }), /near must be/);
  });

  it("relays the daemon's reason and says when nothing was found", async () => {
    const lost = ctxWith({ "POST /api/genui/places": refuse(404, "Couldn't find \"Atlantis\" on the map — try a fuller name (street, district, city).") });
    await assert.rejects(findPlacesDef.handler(lost.ctx, { query: "x", near: "Atlantis" }), /^Error: Couldn't find "Atlantis"/);
    const none = ctxWith({ "POST /api/genui/places": () => ({ ...PLACES, places: [] }) });
    assert.match(String(await findPlacesDef.handler(none.ctx, { query: "x", near: "Moda" })), /^No places for "x"/);
  });
});

describe("current_location", () => {
  it("returns a one-line summary and the JSON", async () => {
    const { ctx } = ctxWith({ "GET /api/location": () => HERE });
    const [head, json] = String(await currentLocationDef.handler(ctx, {})).split("\n");
    assert.equal(head, "Kadıköy, İstanbul, Türkiye · ±35 m · just now");
    assert.deepEqual(JSON.parse(json), { lat: HERE.lat, lon: HERE.lon, accuracy: 35, at: HERE.at, area: HERE.area });
  });

  it("relays a refusal as the daemon's sentence", async () => {
    const { ctx } = ctxWith({ "GET /api/location": refuse(503, "The Eos app isn't running, so this Mac's location can't be read right now.") });
    await assert.rejects(currentLocationDef.handler(ctx, {}), (e: unknown) => e instanceof Error && e.message === "The Eos app isn't running, so this Mac's location can't be read right now.");
  });
});
