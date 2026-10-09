// Number formatting for Value, Slider, Meter, Chart and Table cells: the
// viewer's locale (Intl), never a hand-rolled separator.

import { currencySymbol } from "../content/util.js";

const FORMATS = new Set(["number", "int", "currency", "percent", "compact"]);
const fmtCache = new Map();

function nf(locale, opts) {
  const key = `${locale ?? ""}|${JSON.stringify(opts)}`;
  let f = fmtCache.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(locale, opts);
    } catch {
      f = new Intl.NumberFormat(locale, { maximumFractionDigits: opts.maximumFractionDigits ?? 2 });
    }
    if (fmtCache.size > 200) fmtCache.clear();
    fmtCache.set(key, f);
  }
  return f;
}

function validCurrency(code) {
  if (typeof code !== "string" || !/^[A-Za-z]{3}$/.test(code)) return null;
  try {
    new Intl.NumberFormat(undefined, { style: "currency", currency: code });
    return code.toUpperCase();
  } catch {
    return null;
  }
}

function clampDecimals(d) {
  const n = Number(d);
  return Number.isFinite(n) ? Math.max(0, Math.min(6, Math.trunc(n))) : null;
}

// formatNumber(9400, {format: "currency", currency: "TRY"}) → "₺9.400" (tr-TR).
// percent takes a fraction (0.2 → 20%), as Intl does.
export function formatNumber(value, { format = "number", decimals, currency, locale, prefix = "", suffix = "" } = {}) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "";
  const kind = FORMATS.has(format) ? format : "number";
  const d = clampDecimals(decimals);
  let out;
  if (kind === "currency") {
    const code = validCurrency(currency);
    if (code) {
      const digits = d ?? (Number.isInteger(n) || Math.abs(n) >= 1000 ? 0 : 2);
      out = nf(locale, { style: "currency", currency: code, currencyDisplay: "narrowSymbol", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
    } else {
      out = `${typeof currency === "string" ? currency : ""}${nf(locale, { maximumFractionDigits: d ?? (Math.abs(n) >= 1000 ? 0 : 2) }).format(n)}`;
    }
  } else if (kind === "percent") {
    out = nf(locale, { style: "percent", maximumFractionDigits: d ?? 1, minimumFractionDigits: d ?? 0 }).format(n);
  } else if (kind === "compact") {
    out = nf(locale, { notation: "compact", maximumFractionDigits: d ?? 1 }).format(n);
  } else if (kind === "int") {
    out = nf(locale, { maximumFractionDigits: 0 }).format(Math.round(n));
  } else {
    const auto = Math.abs(n) >= 1000 ? 0 : Math.abs(n) >= 100 ? 1 : 2;
    out = nf(locale, { maximumFractionDigits: d ?? auto, minimumFractionDigits: d ?? 0 }).format(n);
  }
  return `${prefix ?? ""}${out}${suffix ?? ""}`;
}

// "9,8" + "s" → "9,8s"; "1,24" + "kg" → "1,24 kg".
export function withUnit(text, unit) {
  if (!unit || !text) return text;
  const u = String(unit);
  return /^(%|s|ms|h|m|x|×|°|″|′)$/.test(u) ? `${text}${u}` : `${text} ${u}`;
}

// Price level 1–4 as repeated currency symbols: 2 → "₺₺" (the symbol Kit A's
// Price uses: the item's currency, else the viewer's locale).
export function priceLevel(level, currency) {
  const n = Math.round(Number(level));
  if (!Number.isFinite(n) || n < 1) return "";
  let sym = currencySymbol(currency);
  if (Array.from(sym).length > 1) sym = "$";
  return sym.repeat(Math.min(4, n));
}
