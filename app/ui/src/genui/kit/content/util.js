// Helpers shared by the layout, content and entity kits: class joining,
// templates in the current item scope, media URL chains and small formatters.

import { fillTemplate, hasTemplate } from "../../../../../../contracts/src/genui/expr.ts";
import { attrText } from "../../../../../../contracts/src/genui/attrs.ts";

export function cls(...parts) {
  return parts.filter(Boolean).join(" ");
}

// The text children of an element: node.text (dedented inline markdown), or the
// plain string children when the component is rendered directly.
export function textOf(node, children) {
  if (node && typeof node.text === "string") return node.text;
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children) && children.every((c) => typeof c === "string" || typeof c === "number")) return children.join("");
  return "";
}

// An attribute as display text, its {field} holes filled from the item (and
// state/data). Plain text passes through untouched.
export function tpl(view, value, item) {
  if (value == null || value === false) return "";
  const s = attrText(value);
  if (!hasTemplate(s) && !s.includes("{{")) return s;
  if (view && typeof view.template === "function") return view.template(s, item ?? undefined);
  return fillTemplate(s, { item: item ?? undefined, state: view?.state, data: view?.data });
}

// Text children are templated only inside a per-item template (List detail),
// where braces are meant as fields; elsewhere they are literal prose.
export function scopedText(view, text, item) {
  return item ? tpl(view, text, item) : text;
}

export function isTone(t) {
  return typeof t === "string" && ["blue", "green", "amber", "red", "violet", "teal"].includes(t.toLowerCase());
}

export function toneClass(t) {
  return isTone(t) ? `gv-tone-${t.toLowerCase()}` : "";
}

export function hostOf(url) {
  if (typeof url !== "string") return "";
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url.trim());
  const host = (m ? m[1] : url.trim().split(/[/?#]/)[0]).replace(/^www\./i, "").replace(/:\d+$/, "");
  return host.includes(".") && !/\s/.test(host) ? host.toLowerCase() : "";
}

// The domain that names an entity's brand: site=, else its url's host.
export function siteOf(item) {
  if (!item || typeof item !== "object") return "";
  if (typeof item.site === "string" && item.site) return hostOf(item.site) || item.site;
  return hostOf(item.url);
}

export function itemName(item) {
  if (!item || typeof item !== "object") return "";
  for (const k of ["name", "title", "label", "path"]) if (typeof item[k] === "string" && item[k]) return item[k];
  return item.id != null ? String(item.id) : "";
}

export function sameId(a, b) {
  return a != null && b != null && String(a) === String(b);
}

function mediaCall(view, kind, arg) {
  if (!arg) return null;
  const fn = view?.media?.[kind];
  if (typeof fn !== "function") return null;
  try {
    return fn(arg) || null;
  } catch {
    return null;
  }
}

function uniq(list) {
  return [...new Set(list.filter(Boolean))];
}

// Photo candidates for an entity, best first: its image(s) through the image
// proxy, then the og:image of its page. Empty → the caller's monogram.
export function photoSrcs(view, item, { all = false } = {}) {
  if (!item || typeof item !== "object") return [];
  const imgs = [];
  if (typeof item.image === "string") imgs.push(item.image);
  if (Array.isArray(item.images)) for (const u of item.images) if (typeof u === "string") imgs.push(u);
  const proxied = imgs.map((u) => mediaCall(view, "img", u));
  if (all) return uniq(proxied);
  return uniq([...proxied, typeof item.url === "string" ? mediaCall(view, "og", item.url) : null]);
}

// Logo candidates for a site: logo.dev (when a key is set), then its own icon.
export function logoSrcs(view, site) {
  if (!site) return [];
  return uniq([mediaCall(view, "logo", site), mediaCall(view, "icon", site)]);
}

export function iconSrcs(view, site) {
  return site ? uniq([mediaCall(view, "icon", site)]) : [];
}

// Opens a link, a map or a file through the view runtime (browser panel, file
// panel). Returns false when the runtime can't, so a real <a> keeps its default.
export function openHref(view, href, opts = {}) {
  if (!href || !view) return false;
  if (typeof view.open === "function") {
    view.open(href, opts);
    return true;
  }
  return false;
}

// Clicks on links inside rendered markdown go through openHref.
export function interceptLinks(view) {
  return (e) => {
    const a = e.target?.closest?.("a[href]");
    if (!a) return;
    if (openHref(view, a.getAttribute("href"))) e.preventDefault();
  };
}

export function formatCount(n) {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return String(n ?? "");
  try {
    return new Intl.NumberFormat().format(v);
  } catch {
    return String(v);
  }
}

const CURRENCY_SYMBOLS = {
  TRY: "₺", TL: "₺", USD: "$", EUR: "€", GBP: "£", JPY: "¥", CNY: "¥", INR: "₹", KRW: "₩", RUB: "₽",
  UAH: "₴", ILS: "₪", NGN: "₦", PHP: "₱", VND: "₫", THB: "฿", PLN: "zł", CHF: "CHF", SEK: "kr", NOK: "kr", DKK: "kr",
};
const REGION_CURRENCY = {
  TR: "TRY", US: "USD", GB: "GBP", JP: "JPY", CN: "CNY", IN: "INR", KR: "KRW", RU: "RUB", UA: "UAH", IL: "ILS",
  NG: "NGN", PH: "PHP", VN: "VND", TH: "THB", PL: "PLN", CH: "CHF", SE: "SEK", NO: "NOK", DK: "DKK",
  DE: "EUR", FR: "EUR", ES: "EUR", IT: "EUR", NL: "EUR", PT: "EUR", IE: "EUR", AT: "EUR", BE: "EUR", FI: "EUR", GR: "EUR",
};

function localeRegion() {
  try {
    const lang = (typeof navigator !== "undefined" && navigator.language) || Intl.DateTimeFormat().resolvedOptions().locale || "";
    const m = /[-_]([A-Za-z]{2})\b/.exec(lang);
    return m ? m[1].toUpperCase() : "";
  } catch {
    return "";
  }
}

// "TRY" → "₺"; a symbol passes through; nothing → the locale's own currency.
export function currencySymbol(currency) {
  if (typeof currency === "string" && currency.trim()) {
    const c = currency.trim();
    return CURRENCY_SYMBOLS[c.toUpperCase()] ?? c;
  }
  return CURRENCY_SYMBOLS[REGION_CURRENCY[localeRegion()]] ?? "$";
}

// "1250" + "TRY" → "₺1,250" (locale grouping); free text stays as written.
export function formatAmount(amount, currency) {
  if (amount == null || amount === "") return "";
  const n = typeof amount === "number" ? amount : /^\s*-?\d+(\.\d+)?\s*$/.test(String(amount)) ? Number(amount) : null;
  const sym = currency ? currencySymbol(currency) : "";
  if (n == null) return sym && !String(amount).includes(sym) ? `${sym}${amount}` : String(amount);
  return `${sym}${formatCount(n)}`;
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
