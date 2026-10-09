// Geometry for the hand-rolled SVG charts: series from rows, nice axis ticks,
// line / area / bar / donut shapes. Pure — the component only draws.

import { getPath, looseNumber } from "./util.js";

function label(v, i) {
  if (v == null || v === "") return String(i + 1);
  if (typeof v === "object") return String(v.name ?? v.title ?? v.label ?? i + 1);
  return String(v);
}

// Fields every row (that has it) holds as a number, in first-seen order.
export function numericFields(items, exclude = []) {
  const skip = new Set([...exclude, "id", "geo", "source", "type"]);
  const seen = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    for (const [k, v] of Object.entries(it)) {
      if (skip.has(k) || seen.includes(k)) continue;
      if (typeof v === "number") seen.push(k);
    }
  }
  return seen.filter((k) => items.every((it) => it?.[k] == null || typeof it[k] === "number"));
}

// {labels, series: [{key, values}]} from rows (x= labels, y= fields) or from a
// plain number list (values=).
export function chartData(items, { x, y = [], values } = {}) {
  if (!Array.isArray(items) || !items.length) {
    const list = Array.isArray(values) ? values.map((v) => looseNumber(v)) : [];
    return { labels: list.map((_, i) => String(i + 1)), series: list.length ? [{ key: "value", values: list }] : [] };
  }
  const xField = typeof x === "string" && x ? x : ["label", "name", "title", "x", "day", "date", "time"].find((f) => items.some((it) => it?.[f] != null)) ?? null;
  const fields = y.length ? y : numericFields(items, xField ? [xField] : []).slice(0, 1);
  return {
    labels: items.map((it, i) => label(xField ? getPath(it, xField) : null, i)),
    series: fields.map((key) => ({ key, values: items.map((it) => looseNumber(getPath(it, key))) })),
  };
}

// Round axis ticks over [min, max]: steps of 1 / 2 / 5 × 10^k.
export function niceScale(min, max, count = 4) {
  let lo = Number.isFinite(min) ? min : 0;
  let hi = Number.isFinite(max) ? max : 1;
  if (lo === hi) {
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.5 : 1;
    lo -= lo >= 0 && lo - pad < 0 ? lo : pad;
    hi += pad;
  }
  const rough = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const nlo = Math.floor(lo / step + 1e-9) * step;
  const nhi = Math.ceil(hi / step - 1e-9) * step;
  const ticks = [];
  for (let v = nlo; v <= nhi + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return { min: nlo, max: nhi, step, ticks };
}

// [min, max] of the plotted values; stacked sums per index; bars and areas
// stand on zero.
export function valueExtent(series, { stacked = false, zero = false } = {}) {
  let lo = Infinity;
  let hi = -Infinity;
  if (stacked) {
    const n = Math.max(0, ...series.map((s) => s.values.length));
    for (let i = 0; i < n; i++) {
      const sum = series.reduce((acc, s) => acc + (s.values[i] ?? 0), 0);
      lo = Math.min(lo, sum);
      hi = Math.max(hi, sum);
    }
  } else {
    for (const s of series) for (const v of s.values) if (v != null) [lo, hi] = [Math.min(lo, v), Math.max(hi, v)];
  }
  if (!Number.isFinite(lo)) return [0, 1];
  if (zero) [lo, hi] = [Math.min(0, lo), Math.max(0, hi)];
  return [lo, hi];
}

export function scaleY(v, lo, hi, top, bottom) {
  if (hi === lo) return bottom;
  return bottom - ((v - lo) / (hi - lo)) * (bottom - top);
}

// x of each of n points spread over [left, right]; one point sits centered.
export function pointXs(n, left, right) {
  if (n <= 0) return [];
  if (n === 1) return [(left + right) / 2];
  const step = (right - left) / (n - 1);
  return Array.from({ length: n }, (_, i) => left + i * step);
}

// Band centers and width for n bars in [left, right].
export function bandXs(n, left, right, gapRatio = 0.28) {
  if (n <= 0) return { xs: [], band: 0, bar: 0 };
  const band = (right - left) / n;
  const bar = Math.max(2, band * (1 - gapRatio));
  return { xs: Array.from({ length: n }, (_, i) => left + band * (i + 0.5)), band, bar };
}

const r2 = (v) => Math.round(v * 100) / 100;

// "M x y L x y …"; a null point breaks the line into separate runs.
export function linePath(points) {
  let d = "";
  let pen = false;
  for (const p of points) {
    if (!p) {
      pen = false;
      continue;
    }
    d += `${pen ? " L" : d ? " M" : "M"}${r2(p.x)} ${r2(p.y)}`;
    pen = true;
  }
  return d;
}

// Closed area under each run of points, down to baseY.
export function areaPath(points, baseY) {
  const runs = [];
  let run = [];
  for (const p of points) {
    if (p) run.push(p);
    else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  return runs
    .map((r) => `M${r2(r[0].x)} ${r2(baseY)} ${r.map((p) => `L${r2(p.x)} ${r2(p.y)}`).join(" ")} L${r2(r[r.length - 1].x)} ${r2(baseY)} Z`)
    .join(" ");
}

// The band between an upper and a lower line (stacked areas).
export function areaBetween(upper, lower) {
  const pts = upper.map((p, i) => (p && lower[i] ? [p, lower[i]] : null)).filter(Boolean);
  if (!pts.length) return "";
  const top = pts.map(([p]) => `${r2(p.x)} ${r2(p.y)}`);
  const bottom = pts.map(([, q]) => `${r2(q.x)} ${r2(q.y)}`).reverse();
  return `M${top.join(" L")} L${bottom.join(" L")} Z`;
}

// A bar with rounded top corners (6) and slightly rounded bottom ones (2).
export function barPath(x, y, w, h, rTop = 6, rBottom = 2) {
  if (h <= 0 || w <= 0) return "";
  const t = Math.min(rTop, w / 2, h);
  const b = Math.min(rBottom, w / 2, Math.max(0, h - t));
  return [
    `M${r2(x)} ${r2(y + t)}`,
    `Q${r2(x)} ${r2(y)} ${r2(x + t)} ${r2(y)}`,
    `L${r2(x + w - t)} ${r2(y)}`,
    `Q${r2(x + w)} ${r2(y)} ${r2(x + w)} ${r2(y + t)}`,
    `L${r2(x + w)} ${r2(y + h - b)}`,
    `Q${r2(x + w)} ${r2(y + h)} ${r2(x + w - b)} ${r2(y + h)}`,
    `L${r2(x + b)} ${r2(y + h)}`,
    `Q${r2(x)} ${r2(y + h)} ${r2(x)} ${r2(y + h - b)}`,
    "Z",
  ].join(" ");
}

// Donut slices on a circle of circumference 100 (r = 15.9155), starting at
// 12 o'clock: stroke-dasharray / stroke-dashoffset per slice.
export const DONUT_R = 15.9155;
export function donutSegments(values) {
  const nums = values.map((v) => (v != null && v > 0 ? v : 0));
  const total = nums.reduce((a, b) => a + b, 0);
  if (!total) return [];
  let start = 0;
  return nums.map((v) => {
    const frac = v / total;
    const seg = { frac, dash: `${r2(frac * 100)} ${r2(100 - frac * 100)}`, offset: r2(25 - start * 100) };
    start += frac;
    return seg;
  });
}

// Index of the x nearest px.
export function nearestIndex(xs, px) {
  let best = -1;
  let dist = Infinity;
  xs.forEach((x, i) => {
    const d = Math.abs(x - px);
    if (d < dist) [best, dist] = [i, d];
  });
  return best;
}

// Every k-th label so labels don't collide: about one per 56px.
export function labelStride(n, width, minGap = 56) {
  if (n <= 1) return 1;
  return Math.max(1, Math.ceil(n / Math.max(1, Math.floor(width / minGap))));
}
