// What a disc says under its name (08 §4.5) and which discs the text in the
// input is about.

import { numberWord } from "../home/homeWords.js";
import { itemIn } from "../input/intent/localIntent.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function nextWords(at, now) {
  const d = new Date(at);
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY_MS);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  if (days <= 0) return `Next at ${time}`;
  if (days === 1) return "Next tomorrow";
  return `Next on ${d.toLocaleDateString("en", { weekday: "long" })}`;
}

// Tier 1: what waits for the user; tier 2: what it is doing or made; tier 3:
// when it runs next, or how long it has been quiet.
export function discStatus(disc, row, now) {
  if (disc.tier === 1) {
    if (disc.needs > 0) return `${capital(numberWord(disc.needs))} waiting for you`;
    return "Paused, needs a look";
  }
  if (disc.running) return row.lastRun?.state === "running" && row.lastRun.headline ? row.lastRun.headline : "At work";
  if (disc.fresh) return row.lastRun?.headline ?? "A result is ready";
  if (disc.nextAt != null) return nextWords(disc.nextAt, now);
  const ended = row.lastRun?.endedAt;
  if (!ended) return "Not run yet";
  const days = Math.floor((now - ended) / DAY_MS);
  return days < 1 ? "Quiet today" : `Quiet for ${numberWord(days)} day${days === 1 ? "" : "s"}`;
}

const WORD = /[\p{L}\p{N}]/u;
function holdsWord(lower, phrase) {
  const p = phrase.toLowerCase();
  const at = lower.indexOf(p);
  if (at === -1 || !p) return false;
  const before = lower[at - 1];
  const after = lower[at + p.length];
  return !(before && WORD.test(before)) && !(after && WORD.test(after));
}

// The routines the text names or holds an item of; empty when it is about
// none, so nothing dims.
export function discsMatching(routines, text) {
  const lower = text.trim().toLowerCase();
  if (!lower || lower.startsWith("/")) return new Set();
  const named = routines.filter((r) => [r.name, r.slug, ...(r.aliases ?? [])].filter(Boolean).some((n) => holdsWord(lower, n)) || itemIn(r, text) !== null);
  return new Set(named.map((r) => r.id));
}
