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

export const usd = (n) => (n == null ? null : `$${n.toFixed(2)}`);

// The value a column sorts by; a routine without one goes last either way.
const SORTS = {
  name: (r) => r.routine.name.toLowerCase(),
  kind: (r) => kindWord(r.routine.kind),
  status: (r) => r.line,
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
