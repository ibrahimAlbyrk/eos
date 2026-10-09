// Image URLs for the kit. Nothing a view shows is fetched from the open web by
// the page itself: images, a page's og:image and site icons go through the
// daemon's media proxy (api.daemon already carries a controlled host's /h/<id>
// prefix). The one exception is logo.dev, whose terms require hotlinking — used
// only when the user set a publishable key. null = nothing to load → monogram.

import { api } from "../../api/client.js";
import { getGenuiSettings } from "./genuiSettings.js";

const HTTP_RE = /^https?:\/\/[^\s/]+/i;

// "https://www.Example.com/menu" or "example.com" → "example.com".
export function domainOf(site) {
  if (typeof site !== "string") return null;
  let s = site.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : null;
}

export function imgUrl(url) {
  return typeof url === "string" && HTTP_RE.test(url.trim()) ? api.genuiImgUrl(url.trim()) : null;
}

export function ogUrl(pageUrl) {
  return typeof pageUrl === "string" && HTTP_RE.test(pageUrl.trim()) ? api.genuiOgUrl(pageUrl.trim()) : null;
}

export function iconUrl(site) {
  const d = domainOf(site);
  return d ? api.genuiIconUrl(d) : null;
}

export function logoUrl(site, key = getGenuiSettings().logoDevKey) {
  const d = domainOf(site);
  if (!d || !key) return null;
  return `https://img.logo.dev/${encodeURIComponent(d)}?token=${encodeURIComponent(key)}&theme=dark`;
}

export const media = { img: imgUrl, og: ogUrl, icon: iconUrl, logo: logoUrl };

// The media helpers for one logo.dev key — a new object when the key changes,
// so a view built on it re-renders and its logos appear (or go).
export function mediaFor(key) {
  return { img: imgUrl, og: ogUrl, icon: iconUrl, logo: (site) => logoUrl(site, key ?? null) };
}

// Monogram fallback: initials + a tone hashed from the name, so the same
// entity gets the same color everywhere.
const MONO_TONES = ["blue", "green", "amber", "red", "violet", "teal"];

export function monogramOf(name) {
  const words = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  let h = 0;
  for (const ch of String(name ?? "")) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return { text: letters.toLocaleUpperCase(), tone: MONO_TONES[h % MONO_TONES.length] };
}
