import { formatBytes } from "../../lib/format.js";

// Words the Transfer tab shows for a transfer — one place, so the card, the
// recent list and the agent tool card say it the same way.

export function namesOf(t) {
  const names = t.roots.map((r) => r.name);
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.length} items`;
}

export function percentOf(t) {
  return t.totalBytes ? Math.min(100, Math.floor((t.doneBytes * 100) / t.totalBytes)) : 0;
}

export function rateLabel(rate) {
  return rate > 0 ? `${formatBytes(Math.round(rate))}/s` : null;
}

export function etaLabel(t) {
  if (!(t.rate > 0) || t.totalBytes <= t.doneBytes) return null;
  const s = Math.ceil((t.totalBytes - t.doneBytes) / t.rate);
  if (s < 60) return `${s} s left`;
  const m = Math.round(s / 60);
  return m < 60 ? `about ${m} min left` : `about ${Math.round(m / 60)} h left`;
}

export function routeWord(route) {
  return { direct: "direct", relay: "relay", reverse: "tunnel", local: null }[route] ?? null;
}

// macOS homes are /Users/<name> on every Mac, so "~" reads right for either side.
export function tildify(path) {
  return path ? path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~") : path;
}

export const folderName = (path) => (path ? path.replace(/\/+$/, "").split("/").pop() || path : "");
