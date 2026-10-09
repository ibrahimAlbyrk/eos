// Forward and reverse geocoding through OpenStreetMap's Nominatim, within its
// usage policy: an identifying User-Agent, at most one request per second
// (one queue for the whole daemon), and every answer cached on disk so a
// repeated pin or a reopened view never asks again.

import type { Clock } from "../../../../core/src/ports/Clock.ts";
import type { Geocoder } from "../../../../core/src/ports/Geocoder.ts";
import type { Area, GeocodeResult } from "../../../../contracts/src/genui/spec.ts";
import { JsonTtlStore } from "./JsonTtlStore.ts";

export const NOMINATIM_URL = "https://nominatim.openstreetmap.org";
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors (ODbL)";

const MIN_INTERVAL_MS = 1000;
const TIMEOUT_MS = 8000;
const HIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EMPTY_TTL_MS = 24 * 60 * 60 * 1000;
// Asks beyond this many waiting are refused rather than queued for a minute.
const MAX_WAITING = 30;

export type GeoFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export class GeoServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeoServiceError";
  }
}

interface NominatimAddress {
  [k: string]: string | undefined;
}

interface NominatimPlace {
  lat?: string;
  lon?: string;
  display_name?: string;
  name?: string;
  type?: string;
  category?: string;
  addresstype?: string;
  address?: NominatimAddress;
}

export function areaOf(address: NominatimAddress | undefined): Area | undefined {
  if (!address) return undefined;
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = address[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return undefined;
  };
  const area: Area = {
    district: pick("suburb", "city_district", "district", "borough", "quarter", "neighbourhood"),
    city: pick("city", "town", "village", "municipality", "county", "province", "state"),
    country: pick("country"),
  };
  for (const k of Object.keys(area) as Array<keyof Area>) if (area[k] === undefined) delete area[k];
  return Object.keys(area).length ? area : undefined;
}

export function toGeocodeResult(p: NominatimPlace): GeocodeResult | null {
  const lat = Number(p.lat);
  const lon = Number(p.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const out: GeocodeResult = { lat, lon, label: p.display_name || p.name || `${lat.toFixed(5)}, ${lon.toFixed(5)}` };
  const area = areaOf(p.address);
  if (area) out.area = area;
  const kind = p.type || p.addresstype;
  if (kind) out.kind = kind;
  return out;
}

export class NominatimGeocoder implements Geocoder {
  private readonly fetch: GeoFetch;
  private readonly clock: Clock;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly store: JsonTtlStore<unknown>;
  private readonly userAgent: string;
  private readonly baseUrl: string;
  private readonly minIntervalMs: number;
  private tail: Promise<void> = Promise.resolve();
  private lastStart = Number.NEGATIVE_INFINITY;
  private waiting = 0;

  constructor(opts: {
    store: JsonTtlStore<unknown>;
    clock: Clock;
    userAgent: string;
    fetch?: GeoFetch;
    sleep?: (ms: number) => Promise<void>;
    baseUrl?: string;
    minIntervalMs?: number;
  }) {
    this.store = opts.store;
    this.clock = opts.clock;
    this.userAgent = opts.userAgent;
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.baseUrl = opts.baseUrl ?? NOMINATIM_URL;
    this.minIntervalMs = opts.minIntervalMs ?? MIN_INTERVAL_MS;
  }

  async search(q: string, limit = 5): Promise<GeocodeResult[]> {
    const query = q.trim().replace(/\s+/g, " ");
    if (!query) return [];
    const n = Math.max(1, Math.min(10, Math.floor(limit)));
    const key = `s:${n}:${query.toLowerCase()}`;
    const hit = this.store.get(key);
    if (Array.isArray(hit)) return hit as GeocodeResult[];
    const params = new URLSearchParams({ q: query, format: "jsonv2", addressdetails: "1", limit: String(n) });
    const raw = await this.request(`${this.baseUrl}/search?${params}`);
    const list = Array.isArray(raw) ? (raw as NominatimPlace[]).map(toGeocodeResult).filter((r): r is GeocodeResult => r !== null) : [];
    this.store.set(key, list, list.length ? HIT_TTL_MS : EMPTY_TTL_MS);
    return list;
  }

  // The district / city / country around a point. Coordinates are rounded to
  // ~100 m before they leave the Mac (and that's also the cache key).
  async reverse(lat: number, lon: number): Promise<Area | null> {
    const rlat = lat.toFixed(3);
    const rlon = lon.toFixed(3);
    const key = `r:${rlat},${rlon}`;
    const hit = this.store.get(key);
    if (hit !== undefined) return (hit as Area | null) ?? null;
    const params = new URLSearchParams({ lat: rlat, lon: rlon, format: "jsonv2", addressdetails: "1", zoom: "14" });
    const raw = (await this.request(`${this.baseUrl}/reverse?${params}`)) as NominatimPlace | null;
    const area = areaOf(raw?.address) ?? null;
    this.store.set(key, area, area ? HIT_TTL_MS : EMPTY_TTL_MS);
    return area;
  }

  // One request at a time, each starting ≥ minIntervalMs after the previous one.
  private request(url: string): Promise<unknown> {
    if (this.waiting >= MAX_WAITING) return Promise.reject(new GeoServiceError("too many place lookups at once — try again in a moment"));
    this.waiting++;
    const run = this.tail.then(async () => {
      const wait = this.lastStart + this.minIntervalMs - this.clock.now();
      if (wait > 0) await this.sleep(wait);
      this.lastStart = this.clock.now();
      this.waiting--;
      return this.fetchJson(url);
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async fetchJson(url: string): Promise<unknown> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    timer.unref?.();
    try {
      const res = await this.fetch(url, { headers: { "user-agent": this.userAgent, accept: "application/json" }, signal: ac.signal });
      if (!res.ok) throw new GeoServiceError(`OpenStreetMap geocoding answered ${res.status}${res.status === 429 ? " (rate limited)" : ""}`);
      return await res.json();
    } catch (e) {
      if (e instanceof GeoServiceError) throw e;
      throw new GeoServiceError(ac.signal.aborted ? "OpenStreetMap geocoding timed out" : `OpenStreetMap geocoding failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
