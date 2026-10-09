// Helpers shared by the data, inputs and geo kits: tones, item lookup, the
// collection lens (where / skip / sort / limit) and loose number reading.

import { matchWhere } from "../../../../../../contracts/src/genui/expr.ts";
import { attrNum, parseSort, splitIds } from "../../../../../../contracts/src/genui/attrs.ts";
import { TONES as PALETTE, toneVars } from "../../runtime/runtime.js";

// The six view tones, from the runtime's palette. `on` is the text color on a
// tone fill; `light` is the tone as text on a tinted well.
export const TONES = Object.fromEntries(
  Object.entries(PALETTE).map(([name, t]) => [name, { hex: t.accent, on: t.on, light: t.ink }]),
);
export const TONE_ORDER = ["blue", "green", "amber", "red", "violet", "teal"];

export function isTone(t) {
  return typeof t === "string" && Object.prototype.hasOwnProperty.call(TONES, t.toLowerCase());
}

export function toneHex(tone, fallback = TONES.blue.hex) {
  return isTone(tone) ? TONES[tone.toLowerCase()].hex : fallback;
}

// Linear blend of `hex` over `base` — the dim bar color of the Kit B board.
export function mix(hex, base, t) {
  const a = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  const b = /^#?([0-9a-f]{6})$/i.exec(base || "");
  if (!a || !b) return hex;
  const x = parseInt(a[1], 16);
  const y = parseInt(b[1], 16);
  const ch = (s) => Math.round(((y >> s) & 255) + (((x >> s) & 255) - ((y >> s) & 255)) * t);
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, "0")).join("")}`;
}

// CSS variables re-pointing --gv-accent/--gv-soft/--gv-on at a component's own
// tone= (the view root sets them for the view tone).
export function toneStyle(tone) {
  if (!isTone(tone)) return undefined;
  const t = tone.toLowerCase();
  return { ...toneVars(t), "--gv-light": TONES[t].light };
}

// Series colors: the view tone first, then the rest of the palette.
export function seriesColors(viewTone, n) {
  const first = isTone(viewTone) ? viewTone.toLowerCase() : "blue";
  const order = [first, ...TONE_ORDER.filter((t) => t !== first)];
  return Array.from({ length: Math.max(0, n) }, (_, i) => TONES[order[i % order.length]].hex);
}

const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

// Own-property dotted lookup ("hours.until").
export function getPath(obj, path) {
  if (typeof path !== "string" || !path) return undefined;
  let cur = obj;
  for (const k of path.split(".")) {
    if (FORBIDDEN.has(k) || cur == null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

export function itemId(item, index) {
  return item && (typeof item.id === "string" || typeof item.id === "number") ? String(item.id) : String(index);
}

// Selection ids may come back as numbers or strings.
export function sameId(a, b) {
  return a != null && b != null && String(a) === String(b);
}

export function itemName(item) {
  if (!item || typeof item !== "object") return "";
  for (const k of ["name", "title", "label"]) if (typeof item[k] === "string" && item[k]) return item[k];
  return item.id != null ? String(item.id) : "";
}

// Reads "4.7", "650 m", "1,4 km", "₺42.000", "38,4s", "20%" as a comparable
// number (distances in meters). null when there is no number in it.
export function looseNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean" || v == null) return null;
  if (typeof v === "object") {
    if (typeof v.until === "string") return looseNumber(v.until.replace(":", "."));
    return null;
  }
  const s = String(v).trim();
  const m = /-?\d[\d.,\u00a0\u202f ]*/.exec(s);
  if (!m) return null;
  let num = m[0].replace(/[\s\u00a0\u202f]/g, "").replace(/[.,]$/, "");
  const groups = /^-?\d{1,3}([.,])\d{3}(\1\d{3})*$/.exec(num);
  if (groups) num = num.split(groups[1]).join("");
  else {
    const lastSep = Math.max(num.lastIndexOf("."), num.lastIndexOf(","));
    if (lastSep >= 0) num = `${num.slice(0, lastSep).replace(/[.,]/g, "")}.${num.slice(lastSep + 1)}`;
  }
  let n = Number(num);
  if (!Number.isFinite(n)) return null;
  const unit = s.slice(m.index + m[0].length).trim().toLowerCase();
  if (/^km\b/.test(unit)) n *= 1000;
  else if (/^mi\b/.test(unit)) n *= 1609.34;
  else if (/^(h|hr|hrs|hours?|sa|saat)\b/.test(unit)) n *= 3600;
  else if (/^(min|mins|dk|dakika)\b/.test(unit)) n *= 60;
  return n;
}

// Sort comparator: numbers as numbers, text with a locale-aware compare,
// empty values last.
export function compareValues(a, b) {
  const ea = a == null || a === "";
  const eb = b == null || b === "";
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  const na = looseNumber(a);
  const nb = looseNumber(b);
  if (na != null && nb != null) return na - nb;
  return String(sortText(a)).localeCompare(String(sortText(b)), undefined, { numeric: true, sensitivity: "base" });
}

function sortText(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) return v.name ?? v.title ?? v.text ?? v.until ?? "";
  if (Array.isArray(v)) return v.join(", ");
  return v;
}

export function sortItems(items, field, desc) {
  const out = items.map((it, i) => [it, i]);
  out.sort((x, y) => {
    const c = compareValues(getPath(x[0], field), getPath(y[0], field));
    // Empty values stay last in both directions.
    const ex = getPath(x[0], field) == null;
    const ey = getPath(y[0], field) == null;
    if (ex !== ey) return ex ? 1 : -1;
    return (desc ? -c : c) || x[1] - y[1];
  });
  return out.map(([it]) => it);
}

// The element's own lens over a collection: where=, skip=, sort=, limit=.
export function applyLens(items, attrs, state, { limit = true } = {}) {
  if (!Array.isArray(items)) return [];
  let list = items;
  const where = attrs?.where;
  if (typeof where === "string" && where.trim()) list = list.filter((it) => matchWhere(it, where, state));
  const skip = new Set(splitIds(attrs?.skip));
  if (skip.size) list = list.filter((it, i) => !skip.has(itemId(it, i)));
  const sort = parseSort(attrs?.sort);
  if (sort?.field) list = sortItems(list, sort.field, sort.desc);
  const n = attrNum(attrs?.limit);
  if (limit && n != null && n > 0) list = list.slice(0, Math.floor(n));
  return list;
}

// Stable 1-based numbers for a collection's items: their position in the
// element's own lens (where/sort/skip) before the shared Filters chips apply,
// so a pin, a timeline stop and a table row keep their number while chips toggle.
export function numberItems(allItems, attrs, state) {
  const lens = applyLens(allItems, attrs, state, { limit: false });
  const byRef = new Map();
  const byId = new Map();
  lens.forEach((it, i) => {
    byRef.set(it, i + 1);
    if (it && (typeof it.id === "string" || typeof it.id === "number")) byId.set(String(it.id), i + 1);
  });
  return (item) => byRef.get(item) ?? (item && item.id != null ? byId.get(String(item.id)) : undefined) ?? null;
}

export function isActivation(e) {
  return e.key === "Enter" || e.key === " " || e.key === "Spacebar";
}
