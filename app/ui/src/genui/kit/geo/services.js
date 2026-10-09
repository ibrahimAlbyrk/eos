// What the Map asks the daemon for: the proxied style, addresses → coordinates
// (Nominatim behind GET /api/genui/geocode, which rate-limits and caches), and
// the user's location for `you`. Every answer is cached for the app session and
// requests are made one at a time, so a transcript full of maps stays polite.

import { api } from "../../../api/client.js";
import { tuneStyle } from "./mapGeom.js";

// <daemon>/api/genui/map — the host's prefix inside a controlled computer's view.
export function mapBase() {
  try {
    return typeof api.genuiMapBase === "function" ? api.genuiMapBase() : "";
  } catch {
    return "";
  }
}

const styles = new Map();

// The style document, proxied and tuned. The app shell authenticates
// /api/genui/map/* requests, so a plain fetch carries the token.
export function loadStyle(base = mapBase()) {
  if (!base) return Promise.reject(new Error("no daemon"));
  let p = styles.get(base);
  if (!p) {
    p = fetch(`${base}/style.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`map style → ${r.status}`);
        return r.json();
      })
      .then((style) => tuneStyle(style, base))
      .catch((e) => {
        styles.delete(base);
        throw e;
      });
    styles.set(base, p);
  }
  return p;
}

// ── geocode ─────────────────────────────────────────────────────────────────

const geocoded = new Map(); // address → [lat, lon] | null
const geoWaiting = new Map(); // address → Promise
let geoChain = Promise.resolve();

async function fetchGeocode(q) {
  if (typeof api.genuiGeocodeUrl !== "function") return null;
  const r = await fetch(api.genuiGeocodeUrl(q, { limit: 1 }));
  if (!r.ok) return r.status === 404 ? null : Promise.reject(new Error(`geocode → ${r.status}`));
  const body = await r.json();
  const hit = Array.isArray(body?.results) ? body.results[0] : null;
  return hit && Number.isFinite(hit.lat) && Number.isFinite(hit.lon) ? [hit.lat, hit.lon] : null;
}

export function cachedGeocode(address) {
  return geocoded.has(address) ? geocoded.get(address) : undefined;
}

// [lat, lon] for an address, or null when it can't be found. Failures other
// than "not found" are not cached, so a later view retries.
export function geocode(address, fetcher = fetchGeocode) {
  if (geocoded.has(address)) return Promise.resolve(geocoded.get(address));
  let p = geoWaiting.get(address);
  if (!p) {
    p = geoChain.then(() => fetcher(address));
    geoChain = p.catch(() => {});
    p = p
      .then((coord) => {
        geocoded.set(address, coord);
        return coord;
      })
      .catch(() => null)
      .finally(() => geoWaiting.delete(address));
    geoWaiting.set(address, p);
  }
  return p;
}

// ── location ────────────────────────────────────────────────────────────────

const LOCATION_TTL_MS = 5 * 60 * 1000;
let located = { at: 0, coord: null, pending: null };

// The user's [lat, lon] when location sharing is on (403 otherwise → null).
export function userLocation() {
  const now = Date.now();
  if (located.at && now - located.at < LOCATION_TTL_MS) return Promise.resolve(located.coord);
  if (located.pending) return located.pending;
  located.pending = (async () => {
    try {
      const r = await api.getLocation();
      const b = r?.ok ? r.body : null;
      const coord = b && Number.isFinite(b.lat) && Number.isFinite(b.lon) ? [b.lat, b.lon] : null;
      located = { at: Date.now(), coord, pending: null };
      return coord;
    } catch {
      located = { at: Date.now(), coord: null, pending: null };
      return null;
    }
  })();
  return located.pending;
}

export function resetGeoServicesForTests() {
  geocoded.clear();
  geoWaiting.clear();
  geoChain = Promise.resolve();
  styles.clear();
  located = { at: 0, coord: null, pending: null };
}
