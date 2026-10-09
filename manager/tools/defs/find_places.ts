import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import type { LocationResponse, PlacesRequest } from "../../../contracts/src/genui/spec.ts";
import type { Place } from "../../../contracts/src/genui/catalog.ts";
import { safeStringify } from "../../../infra/src/util/json.ts";
import { areaLine, callDaemon } from "./geo_shared.ts";

const DEFAULT_RADIUS_M = 1500;
const DEFAULT_LIMIT = 12;

interface PlacesAnswer {
  places: Place[];
  attribution: string;
  center?: { lat: number; lon: number; label?: string };
  radiusM?: number;
}

// What the agent can put straight into data.sources for the OSM facts.
const OSM_SOURCE = { title: "OpenStreetMap contributors", site: "openstreetmap.org", url: "https://www.openstreetmap.org/copyright", note: "ODbL" };

const clamp = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

function radiusText(m: number): string {
  return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(m % 1000 ? 1 : 0)} km`;
}

export const findPlacesDef: ToolDefinition = {
  name: "find_places",
  visibility: "orchestrator",
  inputSchema: {
    query: z.string().optional().describe("what to look for — a name or a kind: \"ramen\", \"bike repair\""),
    category: z.string().optional().describe("a kind of place: restaurant, cafe, bar, bakery, pharmacy, hotel, museum, supermarket, atm, …"),
    near: z
      .union([z.string(), z.object({ text: z.string() }), z.object({ lat: z.number(), lon: z.number() })])
      .optional()
      .describe("{text: a place name or address} or {lat, lon}; omitted = around the user's current location (needs location sharing)"),
    radiusM: z.number().optional().describe("search radius in meters, 50–20000 (default 1500)"),
    limit: z.number().optional().describe("how many places, 1–40 (default 12)"),
  },
  handler: async (ctx, args) => {
    const query = typeof args.query === "string" && args.query.trim() ? args.query.trim().slice(0, 200) : undefined;
    const category = typeof args.category === "string" && args.category.trim() ? args.category.trim().slice(0, 60) : undefined;
    if (!query && !category) throw new Error("find_places needs a query or a category — e.g. {category: \"cafe\"} or {query: \"ramen\"}");
    const near = await resolveNear(args.near, () => ctx.api("GET", ROUTES.location) as Promise<LocationResponse>);
    const body: PlacesRequest = {
      ...(query ? { query } : {}),
      ...(category ? { category } : {}),
      near: near.point,
      radiusM: clamp(args.radiusM, 50, 20_000, DEFAULT_RADIUS_M),
      limit: clamp(args.limit, 1, 40, DEFAULT_LIMIT),
    };
    const res = (await callDaemon(() => ctx.api("POST", ROUTES.genuiPlaces, body))) as PlacesAnswer;
    const places = Array.isArray(res.places) ? res.places : [];
    const what = query && category ? `"${query}" (${category})` : query ? `"${query}"` : category;
    const where = res.center?.label ?? near.label ?? "the given point";
    const radius = radiusText(res.radiusM ?? body.radiusM ?? DEFAULT_RADIUS_M);
    const head = places.length
      ? `${places.length} place${places.length === 1 ? "" : "s"} for ${what} within ${radius} of ${where}, nearest first — ${res.attribution}. No ratings or prices in OpenStreetMap.`
      : `No places for ${what} within ${radius} of ${where} on OpenStreetMap — try a wider radiusM, a broader category, or another spelling.`;
    if (!places.length) return head;
    return `${head}\n${safeStringify({ places, attribution: res.attribution, source: OSM_SOURCE })}`;
  },
};

// The search point: {lat, lon}, a place name, or — when none is given — the
// user's current location (an error naming the setting when sharing is off).
async function resolveNear(
  near: unknown,
  locate: () => Promise<LocationResponse>,
): Promise<{ point: PlacesRequest["near"]; label?: string }> {
  if (typeof near === "string" && near.trim()) return { point: { text: near.trim().slice(0, 300) } };
  if (near && typeof near === "object") {
    const o = near as Record<string, unknown>;
    if (typeof o.text === "string" && o.text.trim()) return { point: { text: o.text.trim().slice(0, 300) } };
    const lat = Number(o.lat);
    const lon = Number(o.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { point: { lat, lon } };
    throw new Error("find_places: near must be {text: \"a place or address\"} or {lat, lon} with a real latitude and longitude");
  }
  let here: LocationResponse;
  try {
    here = await callDaemon(locate);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`No place given and the user's location isn't available: ${reason} Ask the user where to search, then pass near: {text}.`, { cause: e });
  }
  return { point: { lat: here.lat, lon: here.lon }, label: areaLine(here.area) ? `the user (${areaLine(here.area)})` : "the user's location" };
}
