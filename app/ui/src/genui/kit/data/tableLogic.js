// Table cells, "best" highlighting and header sorting — pure, for tests.

import { formatNumber, priceLevel } from "./format.js";
import { compareValues, getPath, looseNumber } from "./util.js";

// Columns a bare `best` flag highlights, and which end wins.
const AUTO_MAX = /^(rating|score|stars|reviews|votes|battery|speed|accuracy|coverage|uptime|throughput|rank_score|value)$/i;
const AUTO_MIN = /^(price|cost|fee|fees|distance|dist|walk|weight|time|duration|eta|latency|size|delay|errors|rank)$/i;

function hoursText(h) {
  if (h == null) return "";
  if (typeof h === "string") return h;
  if (typeof h !== "object") return String(h);
  if (h.closed === true) return h.text ?? "Closed";
  if (h.text) return h.text;
  if (h.from && h.until) return `${h.from}–${h.until}`;
  return h.until ?? h.from ?? "";
}

// {text, kind}: what one cell shows. kind drives styling (rating, price, mono…).
export function cellDisplay(item, key) {
  const v = getPath(item, key);
  if (v == null || v === "") return { text: "—", kind: "empty" };
  if (key === "rating" && typeof v === "number") return { text: `★ ${(Math.round(v * 10) / 10).toFixed(1)}`, kind: "rating" };
  if (key === "price") {
    if (typeof v === "number" && item?.type === "Place") return { text: priceLevel(v, item?.currency), kind: "price" };
    if (typeof v === "number") return { text: item?.currency ? formatNumber(v, { format: "currency", currency: item.currency }) : formatNumber(v), kind: "number" };
  }
  if (key === "hours") {
    const closing = typeof item?.status === "string" && /^closing$/i.test(item.status.trim());
    return { text: hoursText(v) || "—", kind: closing ? "mono-warn" : "mono" };
  }
  if (key === "geo" && Array.isArray(v)) return { text: v.map((x) => formatNumber(x, { decimals: 4 })).join(", "), kind: "mono" };
  if (typeof v === "number") return { text: formatNumber(v), kind: "number" };
  if (typeof v === "boolean") return { text: v ? "✓" : "–", kind: "bool" };
  if (Array.isArray(v)) return { text: v.map((x) => (typeof x === "object" && x ? x.name ?? x.title ?? "" : String(x))).filter(Boolean).join(", ") || "—", kind: "text" };
  if (typeof v === "object") return { text: String(v.text ?? v.name ?? v.title ?? v.label ?? "") || "—", kind: "text" };
  return { text: String(v), kind: "text" };
}

export function cellNumber(item, key) {
  return looseNumber(getPath(item, key));
}

// parseBest() result → {colKey: "max"|"min"} for the shown columns.
export function bestDirections(best, cols) {
  if (!best) return {};
  const out = {};
  for (const c of cols) {
    if (best === "auto") {
      const leaf = c.key.split(".").pop();
      if (AUTO_MAX.test(leaf)) out[c.key] = "max";
      else if (AUTO_MIN.test(leaf)) out[c.key] = "min";
    } else if (best[c.key]) out[c.key] = best[c.key];
  }
  return out;
}

// {colKey: Set(row index)} of the winning cells. A column with fewer than two
// numbers, or where every row ties, highlights nothing.
export function bestCells(rows, dirs) {
  const out = {};
  for (const [key, dir] of Object.entries(dirs)) {
    const nums = rows.map((r) => cellNumber(r, key));
    const present = nums.filter((n) => n != null);
    if (present.length < 2) continue;
    const target = dir === "min" ? Math.min(...present) : Math.max(...present);
    if (present.every((n) => n === target)) continue;
    out[key] = new Set(nums.map((n, i) => (n === target ? i : -1)).filter((i) => i >= 0));
  }
  return out;
}

// Header clicks cycle: ascending → descending → the view's own order.
export function nextSort(cur, key) {
  if (!cur || cur.field !== key) return { field: key, desc: false };
  if (!cur.desc) return { field: key, desc: true };
  return null;
}

export function sortRows(rows, sort) {
  if (!sort) return rows;
  const out = rows.map((r, i) => [r, i]);
  out.sort((a, b) => {
    const va = getPath(a[0], sort.field);
    const vb = getPath(b[0], sort.field);
    const ea = va == null || va === "";
    const eb = vb == null || vb === "";
    if (ea !== eb) return ea ? 1 : -1;
    const c = compareValues(va, vb);
    return (sort.desc ? -c : c) || a[1] - b[1];
  });
  return out.map(([r]) => r);
}
