// Monograms: the fallback for every image, logo and avatar in the kit. Initials
// come from the name; the tone is a hash of it, so the same place keeps the same
// color in every view (and in every lens of one view).

export const MONO_TONES = ["blue", "green", "amber", "red", "violet", "teal"];

// "modakiyi.example" → "modakiyi"; "https://www.lalbalik.com/x" → "lalbalik".
function siteStem(s) {
  const host = s.replace(/^[a-z]+:\/\//i, "").replace(/^www\./i, "").split(/[/?#:]/)[0];
  if (!host.includes(".") || /\s/.test(host)) return null;
  return host.split(".")[0] || null;
}

function words(name) {
  return name
    .split(/[\s\-_·.,/&+|()]+/u)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+/u, ""))
    .filter(Boolean);
}

// "Moda Kıyı" → "MK", "Ocak 34" → "O3", "modakiyi.example" → "M", "" → "?".
export function initials(name, max = 2) {
  const raw = typeof name === "string" ? name.trim() : name == null ? "" : String(name);
  if (!raw) return "?";
  const stem = siteStem(raw);
  const parts = words(stem ?? raw);
  if (!parts.length) return raw.slice(0, 1).toUpperCase();
  if (stem) return Array.from(parts[0])[0].toLocaleUpperCase();
  return parts
    .slice(0, max)
    .map((w) => Array.from(w)[0].toLocaleUpperCase())
    .join("");
}

// FNV-1a over the normalized name: stable across sessions and machines.
export function hashString(s) {
  let h = 0x811c9dc5;
  const str = String(s ?? "").trim().toLowerCase();
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function monoTone(name) {
  return MONO_TONES[hashString(name) % MONO_TONES.length];
}

export function monogram(name) {
  return { initials: initials(name), tone: monoTone(name) };
}
