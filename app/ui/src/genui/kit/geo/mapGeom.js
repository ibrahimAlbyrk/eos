// Map geometry without MapLibre: pins from a collection, Web Mercator, and a
// fit of the pins into a box — the static map (before the live one loads, when
// it is offscreen, or when WebGL is unavailable) draws from this.

import { itemId, itemName, sameId } from "../data/util.js";

export function validGeo(g) {
  return Array.isArray(g) && g.length === 2 && g.every((n) => typeof n === "number" && Number.isFinite(n)) && Math.abs(g[0]) <= 90 && Math.abs(g[1]) <= 180;
}

// [lat, lon] for `you`: a coordinate pair, or null for the flag / nothing.
export function youCoord(you) {
  return validGeo(you) ? you : null;
}

export function wantsLocation(you) {
  return you === true || you === "true" || you === "";
}

// One pin per item: its number, coordinate (geo, else a geocoded address) and
// whether it is selected. Items with neither stay out (their address may still
// be resolving).
export function buildPins(items, { number, resolved, selected } = {}) {
  const out = [];
  items.forEach((it, i) => {
    if (!it || typeof it !== "object") return;
    const id = itemId(it, i);
    const address = typeof it.address === "string" && it.address.trim() ? it.address.trim() : null;
    const coord = validGeo(it.geo) ? it.geo : address && resolved ? resolved.get(address) ?? null : null;
    out.push({
      id,
      n: (number ? number(it) : null) ?? i + 1,
      name: itemName(it),
      site: typeof it.site === "string" ? it.site : null,
      coord: validGeo(coord) ? coord : null,
      address: validGeo(it.geo) ? null : address,
      selected: sameId(selected, id),
    });
  });
  return out;
}

// Addresses that still need a geocode.
export function pendingAddresses(pins, resolved) {
  const out = [];
  for (const p of pins) if (!p.coord && p.address && !(resolved && resolved.has(p.address)) && !out.includes(p.address)) out.push(p.address);
  return out;
}

export function mercX(lon) {
  return lon / 360 + 0.5;
}

export function mercY(lat) {
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

// Pixel positions of [lat, lon] coordinates fitted into w×h with `pad` around,
// keeping the projection's aspect. One point (or all equal) sits centered.
export function fitPositions(coords, w, h, pad = 36) {
  const pts = coords.map(([lat, lon]) => [mercX(lon), mercY(lat)]);
  if (!pts.length) return [];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const dx = maxX - minX;
  const dy = maxY - minY;
  const iw = Math.max(1, w - pad * 2);
  const ih = Math.max(1, h - pad * 2);
  if (dx < 1e-12 && dy < 1e-12) return pts.map(() => ({ x: w / 2, y: h / 2 }));
  const scale = Math.min(dx > 1e-12 ? iw / dx : Infinity, dy > 1e-12 ? ih / dy : Infinity);
  const ox = (w - dx * scale) / 2;
  const oy = (h - dy * scale) / 2;
  return pts.map(([x, y]) => ({ x: ox + (x - minX) * scale, y: oy + (y - minY) * scale }));
}

// [[west, south], [east, north]] around [lat, lon] coordinates, for fitBounds.
export function lngLatBounds(coords) {
  if (!coords.length) return null;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [lat, lon] of coords) {
    w = Math.min(w, lon);
    e = Math.max(e, lon);
    s = Math.min(s, lat);
    n = Math.max(n, lat);
  }
  return [
    [w, s],
    [e, n],
  ];
}

export function pinsKey(pins) {
  return pins.map((p) => `${p.id}:${p.n}:${p.coord ? p.coord.join(",") : "-"}`).join("|");
}

// Strips the HTML a style's attribution strings carry: "© OpenMapTiles …".
export function attributionText(list) {
  const seen = [];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const text = raw
      .replace(/<[^>]*>/g, " ")
      .replace(/&copy;/gi, "©")
      .replace(/&amp;/gi, "&")
      .replace(/&nbsp;/gi, " ")
      .replace(/&[a-z]+;/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text && !seen.includes(text)) seen.push(text);
  }
  return seen.join(" · ");
}

export const DEFAULT_ATTRIBUTION = "© OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors";

// Every tile, glyph and sprite goes through the daemon's proxy at <base>/t/…
// (base = <daemon>/api/genui/map, which is /h/<host>/… in a controlled
// computer's view). The daemon's style already says "/api/genui/map/t/…"
// (root-relative); an OpenFreeMap URL that slipped through is pointed there too.
export const TILE_ORIGIN = "https://tiles.openfreemap.org/";
const PROXY_MARK = "/api/genui/map/t/";

export function proxiedUrl(url, base) {
  if (typeof url !== "string" || !base) return url;
  if (url.startsWith(`${base}/`)) return url;
  if (url.startsWith(TILE_ORIGIN)) return `${base}/t/${url.slice(TILE_ORIGIN.length)}`;
  if (url.startsWith(PROXY_MARK)) return `${base}/t/${url.slice(PROXY_MARK.length)}`;
  // Already resolved against the page (eos://app/api/genui/map/t/…).
  const at = url.indexOf(PROXY_MARK);
  if (at > 0 && !/^https?:\/\//i.test(url)) return `${base}/t/${url.slice(at + PROXY_MARK.length)}`;
  return url;
}

// The style with every proxy path made absolute against `base`, and the
// background and water recolored to the boards' map surface.
export function tuneStyle(style, base) {
  const walk = (v) => {
    if (typeof v === "string") return proxiedUrl(v, base);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, x] of Object.entries(v)) if (k !== "__proto__") out[k] = walk(x);
      return out;
    }
    return v;
  };
  const out = walk(style);
  if (out && Array.isArray(out.layers)) {
    out.layers = out.layers.map((layer) => {
      if (!layer || typeof layer !== "object") return layer;
      if (layer.type === "background") return { ...layer, paint: { ...(layer.paint ?? {}), "background-color": "#141414" } };
      if (layer.type === "fill" && /^water/i.test(String(layer.id ?? ""))) return { ...layer, paint: { ...(layer.paint ?? {}), "fill-color": "#0f1b26" } };
      return layer;
    });
  }
  return out;
}
