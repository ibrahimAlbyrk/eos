// What Home says (08 G7–G9): the greeting and its counts in words, the
// horizon's buckets and summary, the away lines and the learned line. Pure:
// the time comes in as an argument.

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

// Words to ten, digits after.
export const numberWord = (n) => (n >= 0 && n <= 10 ? WORDS[n] : String(n));

const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

export function hello(hour, name) {
  const part = hour >= 5 && hour < 12 ? "Good morning" : hour >= 12 && hour < 18 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name}.` : `${part}.`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// The local midnight before `now`.
export function dayStart(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// "overnight" when the absence covered 00:00–05:00 and it is still morning;
// otherwise the count is since the user was last here.
export function absenceWord(now, lastSeen) {
  const midnight = dayStart(now);
  const overnight = new Date(now).getHours() < 12 && (lastSeen == null || lastSeen <= midnight);
  return overnight && now >= midnight + 5 * HOUR_MS ? "overnight" : "since you were last here";
}

export function handledLine(handled, now, lastSeen) {
  const when = absenceWord(now, lastSeen);
  if (!handled) return `Nothing new ${when}.`;
  return `Eos handled ${numberWord(handled)} ${handled === 1 ? "thing" : "things"} ${when}.`;
}

// "Three need you." / "One needs you."; nothing at 0.
export function needLine(count) {
  if (!count) return null;
  return `${capital(numberWord(count))} ${count === 1 ? "needs" : "need"} you.`;
}

export const FIRST_RUN_LINE = "Tell Eos what to take care of. It shows you a trial before anything runs.";

// ── Horizon (G8) ──────────────────────────────────────────────────────────
export const BUCKET_MS = 15 * 60 * 1000;
export const BUCKETS = DAY_MS / BUCKET_MS;
const RANK = { waiting: 4, now: 3, done: 2, scheduled: 1 };
const LIVE = new Set(["queued", "running", "checking", "delivering"]);

// A run's state on the horizon.
export function horizonState(run) {
  if (run.needsUser || run.state === "waiting_for_user") return "waiting";
  if (LIVE.has(run.state)) return "now";
  return "done";
}

// Today's runs and later slots in 15-minute buckets, each showing its most
// urgent state, with the time and the first routine that put it there.
// `scheduled` is [{ routineId, at }]; only slots later today count.
export function horizonBuckets(runs, scheduled, now, names = {}) {
  const start = dayStart(now);
  const end = start + DAY_MS;
  const buckets = new Map();
  const put = (at, state, routineId) => {
    if (at < start || at >= end) return;
    const index = Math.floor((at - start) / BUCKET_MS);
    const was = buckets.get(index);
    if (!was || RANK[state] > RANK[was.state]) buckets.set(index, { index, state, at, routineId, name: names[routineId] ?? "A routine" });
  };
  for (const run of runs) put(run.startedAt ?? run.createdAt, horizonState(run), run.routineId);
  for (const slot of scheduled) if (slot.at > now) put(slot.at, "scheduled", slot.routineId);
  return [...buckets.values()].sort((a, b) => a.index - b.index);
}

const STATE_WORDS = { waiting: "waiting for you", now: "running", done: "done", scheduled: "scheduled" };

export const clockOf = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// "08:05 PR Review, waiting for you".
export const bucketTitle = (bucket) => `${clockOf(bucket.at)} ${bucket.name}, ${STATE_WORDS[bucket.state]}`;

// "Today so far: five runs, two of them waiting for you. Two more are scheduled."
export function horizonSummary(runs, scheduled, now) {
  const start = dayStart(now);
  const today = runs.filter((r) => (r.startedAt ?? r.createdAt) >= start);
  const waiting = today.filter((r) => horizonState(r) === "waiting").length;
  const later = scheduled.filter((s) => s.at > now && s.at < start + DAY_MS).length;
  const parts = [];
  if (today.length === 0) parts.push("Nothing has run today.");
  else {
    const n = `${numberWord(today.length)} ${today.length === 1 ? "run" : "runs"}`;
    parts.push(waiting ? `Today so far: ${n}, ${numberWord(waiting)} of them waiting for you.` : `Today so far: ${n}.`);
  }
  if (later) parts.push(`${capital(numberWord(later))} more ${later === 1 ? "is" : "are"} scheduled.`);
  return parts.join(" ");
}

// ── Lists (G9) ────────────────────────────────────────────────────────────
export const NEEDS_CARDS = 3;
export const AWAY_LINES = 5;

// What happened while away: one line per routine, its newest ended run since
// `since`, newest first, five at most.
export function awayLines(runs, since) {
  const seen = new Set();
  const lines = [];
  const ended = runs.filter((r) => r.endedAt && r.endedAt >= since && r.kind !== "trial").sort((a, b) => b.endedAt - a.endedAt);
  for (const run of ended) {
    if (seen.has(run.routineId)) continue;
    seen.add(run.routineId);
    lines.push(run);
    if (lines.length === AWAY_LINES) break;
  }
  return lines;
}

// An away line's words: the run's headline, else what it ran on.
export function awayText(run) {
  if (run.headline) return run.headline;
  if (run.itemTitle) return run.state === "failed" ? `Could not finish ${run.itemTitle}.` : `Finished ${run.itemTitle}.`;
  return run.state === "failed" ? "Could not finish." : "Finished.";
}

// "Eos learned 14 things this week."; nothing at 0.
export function learnedLine(weekly) {
  if (!weekly) return null;
  return `Eos learned ${numberWord(weekly)} ${weekly === 1 ? "thing" : "things"} this week.`;
}

export const STARTER_CHIPS = ["Review my pull requests", "Brief me every morning", "Watch my inbox", "Set up a new project"];

// ── Coming up ─────────────────────────────────────────────────────────────
export const COMING_UP = 4;

// The routines' next runs, soonest first, four at most: [{ routineId, at }].
export function comingUp(next, now) {
  return next
    .filter((n) => n.nextAt != null && n.nextAt > now)
    .map((n) => ({ routineId: n.routineId, at: n.nextAt }))
    .sort((a, b) => a.at - b.at)
    .slice(0, COMING_UP);
}

// "In 18 min", "In 3 h", "Tomorrow", or the weekday.
export function whenWords(at, now) {
  const minutes = Math.max(1, Math.round((at - now) / 60000));
  const start = dayStart(now);
  if (at < start + DAY_MS) return minutes < 60 ? `In ${minutes} min` : `In ${Math.round(minutes / 60)} h`;
  if (at < start + 2 * DAY_MS) return "Tomorrow";
  return new Date(at).toLocaleDateString("en", { weekday: "long" });
}
