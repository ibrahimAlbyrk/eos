// Places near a point from OpenStreetMap through the Overpass API — what the
// find_places tool answers with. Results become contracts `Place` entities the
// agent can drop straight into a view (id "osm:<type>/<id>", geo, cuisine,
// hours text, site, address), nearest first. OSM has no ratings or prices, so
// those stay out. One query at a time, answers cached on disk for a day.

import { createHash } from "node:crypto";

import { PlaceSchema, type Place } from "../../../../contracts/src/genui/catalog.ts";
import type { PlaceSearch, PlaceSearchQuery } from "../../../../core/src/ports/PlaceSearch.ts";
import { JsonTtlStore } from "./JsonTtlStore.ts";
import { GeoServiceError } from "./NominatimGeocoder.ts";

export const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

const TIMEOUT_MS = 25_000;
const TTL_MS = 24 * 60 * 60 * 1000;
// Elements Overpass returns before we sort by distance and keep `limit`.
const FETCH_CAP = 300;

type TagFilter = readonly [key: string, valueRe: string];

// Plain-language categories → OSM tag filters. Anything else is matched as a
// tag value (amenity/shop/tourism/leisure) or a cuisine.
const CATEGORIES: Record<string, readonly TagFilter[]> = {
  restaurant: [["amenity", "^(restaurant|food_court)$"]],
  restaurants: [["amenity", "^(restaurant|food_court)$"]],
  food: [["amenity", "^(restaurant|fast_food|food_court|cafe)$"]],
  "fast food": [["amenity", "^fast_food$"]],
  cafe: [["amenity", "^cafe$"]],
  coffee: [["amenity", "^cafe$"], ["shop", "^coffee$"]],
  bar: [["amenity", "^(bar|pub|biergarten)$"]],
  pub: [["amenity", "^(pub|bar)$"]],
  nightlife: [["amenity", "^(bar|pub|nightclub)$"]],
  bakery: [["shop", "^(bakery|pastry)$"]],
  dessert: [["shop", "^(pastry|confectionery|chocolate)$"], ["amenity", "^ice_cream$"]],
  "ice cream": [["amenity", "^ice_cream$"]],
  pharmacy: [["amenity", "^pharmacy$"]],
  hospital: [["amenity", "^(hospital|clinic)$"]],
  doctor: [["amenity", "^(doctors|clinic)$"]],
  dentist: [["amenity", "^dentist$"]],
  hotel: [["tourism", "^(hotel|hostel|guest_house|motel|apartment)$"]],
  hostel: [["tourism", "^hostel$"]],
  museum: [["tourism", "^(museum|gallery)$"]],
  gallery: [["tourism", "^gallery$"], ["shop", "^art$"]],
  attraction: [["tourism", "^(attraction|viewpoint|museum|artwork)$"]],
  sights: [["tourism", "^(attraction|viewpoint|museum)$"], ["historic", "."]],
  viewpoint: [["tourism", "^viewpoint$"]],
  park: [["leisure", "^(park|garden)$"]],
  playground: [["leisure", "^playground$"]],
  gym: [["leisure", "^(fitness_centre|sports_centre)$"]],
  supermarket: [["shop", "^(supermarket|convenience|greengrocer)$"]],
  grocery: [["shop", "^(supermarket|convenience|greengrocer)$"]],
  market: [["amenity", "^marketplace$"], ["shop", "^(supermarket|greengrocer)$"]],
  shop: [["shop", "."]],
  shopping: [["shop", "^(mall|department_store|clothes|shoes)$"]],
  bookstore: [["shop", "^books$"]],
  atm: [["amenity", "^atm$"]],
  bank: [["amenity", "^bank$"]],
  fuel: [["amenity", "^fuel$"]],
  "gas station": [["amenity", "^fuel$"]],
  "ev charging": [["amenity", "^charging_station$"]],
  parking: [["amenity", "^parking$"]],
  library: [["amenity", "^library$"]],
  cinema: [["amenity", "^cinema$"]],
  theatre: [["amenity", "^theatre$"]],
  coworking: [["amenity", "^coworking_space$"], ["office", "^coworking$"]],
  "post office": [["amenity", "^post_office$"]],
  school: [["amenity", "^(school|university|college)$"]],
  veterinary: [["amenity", "^veterinary$"]],
  laundry: [["shop", "^(laundry|dry_cleaning)$"]],
  hairdresser: [["shop", "^(hairdresser|beauty)$"]],
  "bike rental": [["amenity", "^bicycle_rental$"]],
  "car rental": [["amenity", "^car_rental$"]],
};

const PLACE_KEYS = ["amenity", "shop", "tourism", "leisure"] as const;

// Literal text as an Overpass regex: escaped for POSIX ERE, then for the
// double-quoted QL string it sits in (where a backslash is itself escaped).
export function overpassRegex(text: string): string {
  return text
    .replace(/\p{Cc}/gu, " ")
    .replace(/[\\^$.|?*+()[\]{}]/g, "\\$&")
    .replace(/[\\"]/g, "\\$&");
}

function slug(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function filtersFor(category: string): readonly TagFilter[] {
  const c = slug(category);
  const known = CATEGORIES[c] ?? CATEGORIES[c.replace(/s$/, "")];
  if (known) return known;
  const v = `^${overpassRegex(c.replace(/ /g, "_"))}$`;
  return [...PLACE_KEYS.map((k) => [k, v] as const), ["cuisine", `(^|;)${overpassRegex(c.replace(/ /g, "_"))}($|;)`]];
}

function tagClause([key, re]: TagFilter): string {
  return `["${key}"~"${re}",i]`;
}

// The Overpass QL for a search: union of statements, each limited to named
// features within the radius; `out center` gives ways/relations a point.
export function buildOverpassQuery(q: PlaceSearchQuery): string {
  const around = `(around:${Math.round(q.radiusM)},${q.center.lat.toFixed(6)},${q.center.lon.toFixed(6)})`;
  const statements: string[] = [];
  const text = q.query?.trim() ? overpassRegex(q.query.trim()) : null;
  if (q.category?.trim()) {
    for (const f of filtersFor(q.category)) {
      if (text) {
        statements.push(`nwr${around}${tagClause(f)}["name"~"${text}",i];`);
        statements.push(`nwr${around}${tagClause(f)}["cuisine"~"${text}",i]["name"];`);
      } else {
        statements.push(`nwr${around}${tagClause(f)}["name"];`);
      }
    }
  } else if (text) {
    for (const k of PLACE_KEYS) statements.push(`nwr${around}["name"~"${text}",i]["${k}"];`);
    statements.push(`nwr${around}["cuisine"~"${text}",i]["name"];`);
    statements.push(`nwr${around}[~"^(amenity|shop|tourism|leisure)$"~"^${text.replace(/ /g, "_")}$",i]["name"];`);
  }
  return `[out:json][timeout:20];(${statements.join("")});out center tags ${FETCH_CAP};`;
}

interface OverpassElement {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
}

export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function formatDistance(m: number): string {
  if (m < 950) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(m < 9950 ? 1 : 0)} km`;
}

const clip = (s: string | undefined, max: number): string | undefined => {
  const t = s?.trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function websiteOf(tags: Record<string, string>): { url?: string; site?: string } {
  const raw = (tags.website ?? tags["contact:website"] ?? tags.url ?? "").split(";")[0].trim();
  if (!raw) return {};
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return {};
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const site = /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(host) ? host : undefined;
    const url = u.toString().length <= 2048 ? u.toString() : undefined;
    return { url, site };
  } catch {
    return {};
  }
}

function addressOf(tags: Record<string, string>): string | undefined {
  const street = [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" ");
  const place = tags["addr:suburb"] ?? tags["addr:district"] ?? tags["addr:city"];
  return clip([street || tags["addr:place"], place].filter(Boolean).join(", "), 300);
}

function tagsOf(tags: Record<string, string>): string[] | undefined {
  const out: string[] = [];
  if (tags.outdoor_seating === "yes") out.push("outdoor seating");
  if (tags["diet:vegan"] === "yes" || tags["diet:vegan"] === "only") out.push("vegan options");
  if (tags["diet:vegetarian"] === "yes" || tags["diet:vegetarian"] === "only") out.push("vegetarian options");
  if (tags.takeaway === "yes" || tags.takeaway === "only") out.push("takeaway");
  if (tags.delivery === "yes") out.push("delivery");
  if (tags.wheelchair === "yes") out.push("wheelchair accessible");
  if (tags.internet_access === "wlan" || tags.internet_access === "yes") out.push("wi-fi");
  return out.length ? out : undefined;
}

function hoursOf(tags: Record<string, string>): Place["hours"] | undefined {
  const oh = tags.opening_hours?.trim();
  if (!oh) return undefined;
  if (oh === "24/7") return { text: "Open 24/7" };
  if (oh === "closed" || oh === "off") return { closed: true, text: "Closed" };
  return { text: clip(oh, 80) };
}

// One Overpass element → a Place, or null when it has no name or position.
export function elementToPlace(el: OverpassElement, center: { lat: number; lon: number }): (Place & { distanceM: number }) | null {
  const tags = el.tags ?? {};
  const name = clip(tags.name, 200);
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (!name || typeof lat !== "number" || typeof lon !== "number" || !el.type || el.id == null) return null;
  const meters = distanceM(center, { lat, lon });
  const kind = tags.amenity ?? tags.shop ?? tags.tourism ?? tags.leisure ?? tags.historic;
  const { url, site } = websiteOf(tags);
  const candidate: Record<string, unknown> = {
    id: `osm:${el.type}/${el.id}`,
    type: "Place",
    name,
    geo: [Math.round(lat * 1e6) / 1e6, Math.round(lon * 1e6) / 1e6],
    cuisine: clip(tags.cuisine?.split(";").map((c) => c.trim().replace(/_/g, " ")).filter(Boolean).join(", "), 100),
    hours: hoursOf(tags),
    site,
    url,
    address: addressOf(tags),
    area: clip(tags["addr:suburb"] ?? tags["addr:district"] ?? tags["addr:city"], 100),
    tags: tagsOf(tags),
    distance: formatDistance(meters),
    distanceM: Math.round(meters),
    kind: kind ? kind.replace(/_/g, " ") : undefined,
    phone: clip(tags.phone ?? tags["contact:phone"], 40),
    osm: `https://www.openstreetmap.org/${el.type}/${el.id}`,
  };
  for (const k of Object.keys(candidate)) if (candidate[k] === undefined) delete candidate[k];
  const parsed = PlaceSchema.safeParse(candidate);
  if (parsed.success) return parsed.data as Place & { distanceM: number };
  // A field OSM filled oddly (an unusual website) shouldn't cost the place.
  for (const issue of parsed.error.issues) delete candidate[String(issue.path[0])];
  const retry = PlaceSchema.safeParse(candidate);
  return retry.success ? (retry.data as Place & { distanceM: number }) : null;
}

export class OverpassPlaceSearch implements PlaceSearch {
  private readonly fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>;
  private readonly store: JsonTtlStore<unknown>;
  private readonly userAgent: string;
  private readonly endpoint: string;
  private tail: Promise<void> = Promise.resolve();

  constructor(opts: {
    store: JsonTtlStore<unknown>;
    userAgent: string;
    endpoint?: string;
    fetch?: OverpassPlaceSearch["fetch"];
  }) {
    this.store = opts.store;
    this.userAgent = opts.userAgent;
    this.endpoint = opts.endpoint ?? OVERPASS_URL;
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  async search(q: PlaceSearchQuery): Promise<Place[]> {
    if (!q.query?.trim() && !q.category?.trim()) throw new GeoServiceError("a query or a category is needed");
    const ql = buildOverpassQuery(q);
    const key = createHash("sha256").update(ql).digest("hex");
    let elements = this.store.get(key) as OverpassElement[] | undefined;
    if (!Array.isArray(elements)) {
      elements = await this.serial(() => this.run(ql));
      this.store.set(key, elements, TTL_MS);
    }
    const seen = new Set<string>();
    const places: Array<Place & { distanceM: number }> = [];
    for (const el of elements) {
      const p = elementToPlace(el, q.center);
      if (!p || seen.has(String(p.id))) continue;
      seen.add(String(p.id));
      if (p.distanceM <= q.radiusM * 1.05) places.push(p);
    }
    places.sort((a, b) => a.distanceM - b.distanceM);
    return places.slice(0, q.limit);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async run(ql: string): Promise<OverpassElement[]> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    timer.unref?.();
    try {
      const res = await this.fetch(this.endpoint, {
        method: "POST",
        headers: { "user-agent": this.userAgent, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ data: ql }).toString(),
        signal: ac.signal,
      });
      if (res.status === 429 || res.status === 504) throw new GeoServiceError("OpenStreetMap place search is busy right now — try again in a minute");
      if (!res.ok) throw new GeoServiceError(`OpenStreetMap place search answered ${res.status}`);
      const body = (await res.json()) as { elements?: unknown };
      return Array.isArray(body.elements) ? (body.elements as OverpassElement[]) : [];
    } catch (e) {
      if (e instanceof GeoServiceError) throw e;
      throw new GeoServiceError(ac.signal.aborted ? "OpenStreetMap place search timed out" : `OpenStreetMap place search failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
