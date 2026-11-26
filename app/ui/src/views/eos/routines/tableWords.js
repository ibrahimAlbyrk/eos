// What the routines table says in each column, and how it sorts by one
// (08 §5: dot, name, kind, status line, next run, last result, waiting,
// this week's cost, rung).

import { RUNGS } from "../blueprint/FreedomLadder.jsx";
import { stateChip } from "../run/words.js";

const KINDS = { standing: "Standing", project: "Project", once: "Once" };
export const kindWord = (kind) => KINDS[kind] ?? kind;

export const rungWord = (rung) => RUNGS.find((r) => r.value === rung)?.label ?? rung;

const DAY = 24 * 60 * 60 * 1000;
const startOfDay = (ms) => new Date(ms).setHours(0, 0, 0, 0);

// "Today 14:30", "Tomorrow 07:30", else the weekday or the date.
export function nextWord(at, now) {
  if (at == null) return null;
  const time = new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY);
  if (days <= 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  const day = days < 7
    ? new Date(at).toLocaleDateString(undefined, { weekday: "short" })
    : new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return `${day} ${time}`;
}

// The last run's state in words, without the time it took.
export function lastWord(run, now) {
  if (!run) return null;
  const { text, tone } = stateChip(run, now);
  return { text: run.state === "done" ? "Done" : text, tone };
}

// The status in words; a paused or archived routine that still has things
// waiting says how many, since the table has no column of its own for them.
export const statusWords = ({ line, waiting }) => (waiting > 0 && !line.endsWith("waiting") ? `${line}, ${waiting} waiting` : line);

export const usd = (n) => (n == null ? null : `$${n.toFixed(2)}`);

// The value a column sorts by; a routine without one goes last either way.
const SORTS = {
  name: (r) => r.routine.name.toLowerCase(),
  kind: (r) => kindWord(r.routine.kind),
  // What waits for the user first, the most first; then by the words.
  status: (r) => `${String(999 - Math.min(r.waiting ?? 0, 999)).padStart(3, "0")} ${r.line}`,
  next: (r) => r.nextAt,
  last: (r) => r.routine.lastRun?.endedAt ?? r.routine.lastRun?.createdAt,
  waiting: (r) => r.waiting,
  cost: (r) => r.routine.stats?.cost7d,
  rung: (r) => RUNGS.findIndex((g) => g.value === r.routine.rung),
};

export const SORTABLE = Object.keys(SORTS);

export function sortRows(rows, key, dir) {
  const value = SORTS[key] ?? SORTS.name;
  const sign = dir === "descending" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
    return (x < y ? -1 : x > y ? 1 : 0) * sign;
  });
}

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
export const word = (n) => WORDS[n] ?? String(n);

// The screen's lead: how many routines are in this view, and how many of
// them wait for the user.
export function routinesLead(rows) {
  const n = rows.length;
  const waiting = rows.filter((r) => r.waiting > 0).length;
  const head = `${word(n)} ${n === 1 ? "routine" : "routines"}`;
  if (!waiting) return `${head}.`;
  return `${head}, ${waiting === n ? (n === 1 ? "waiting" : "all waiting") : `${word(waiting).toLowerCase()} of them waiting`} for you.`;
}

// The line under the lead: the soonest next run, or nothing.
export function soonestLine(rows, now) {
  const next = rows.filter((r) => r.nextAt != null && r.nextAt > now).sort((a, b) => a.nextAt - b.nextAt)[0];
  return next ? `Next: ${next.routine.name}, ${nextWord(next.nextAt, now).replace(/^[A-Z]/, (c) => c.toLowerCase())}.` : null;
}

// What each freedom lets a routine do, said of several at once.
const RUNG_DOES = { ask: "ask you each time", draft: "draft for you to send", send_then_tell: "send, then tell you", on_its_own: "act on their own" };

// The freedom most of `rows` share, said once for the lead's dim line ("All
// four draft for you to send."), and that freedom, which a row then leaves
// unsaid; null when no freedom is shared by more than half.
export function sharedRung(rows) {
  const counts = new Map();
  for (const { routine } of rows) counts.set(routine.rung, (counts.get(routine.rung) ?? 0) + 1);
  const [rung, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (!rung || !RUNG_DOES[rung] || n * 2 <= rows.length || rows.length < 2) return null;
  const who = n === rows.length ? (n === 2 ? "Both" : `All ${word(n).toLowerCase()}`) : `${word(n)} of them`;
  return { rung, line: `${who} ${RUNG_DOES[rung]}.` };
}
