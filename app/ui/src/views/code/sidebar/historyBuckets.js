import { basename } from "../../../lib/path.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");

function dayStart(ts, daysBack = 0) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysBack);
  return d.getTime();
}

// Recent buckets show the clock time; older ones the day it happened.
function closedLabel(ts, key, now) {
  const d = new Date(ts);
  if (key === "today" || key === "yesterday") return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (key === "week") return WEEKDAYS[d.getDay()];
  return d.getFullYear() === new Date(now).getFullYear()
    ? `${MONTHS[d.getMonth()]} ${d.getDate()}`
    : `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// How long the session ran: "<1 min", "42 min", "1 h 10 min".
export function ranLabel(ms) {
  if (ms == null || ms < 0) return null;
  const min = Math.floor(ms / 60000);
  if (min < 1) return "<1 min";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

// History entries (newest first) grouped by the day they closed — Today,
// Yesterday, Last 7 days, Older — leaving out empty buckets. `query` keeps the
// entries whose title or folder contains it.
export function historyBuckets(entries, now = Date.now(), query = "") {
  const q = query.trim().toLowerCase();
  const buckets = [
    { key: "today", label: "Today", since: dayStart(now) },
    { key: "yesterday", label: "Yesterday", since: dayStart(now, 1) },
    { key: "week", label: "Last 7 days", since: dayStart(now, 6) },
    { key: "older", label: "Older", since: -Infinity },
  ].map((b) => ({ ...b, items: [] }));
  for (const entry of entries) {
    const folder = basename(entry.cwd);
    if (q && !`${entry.title ?? ""}\n${folder}`.toLowerCase().includes(q)) continue;
    const b = buckets.find((x) => entry.closedAt >= x.since);
    b.items.push({
      entry,
      folder,
      time: closedLabel(entry.closedAt, b.key, now),
      ran: entry.startedAt ? ranLabel(entry.closedAt - entry.startedAt) : null,
    });
  }
  return buckets.filter((b) => b.items.length).map(({ key, label, items }) => ({ key, label, items }));
}
