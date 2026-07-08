// Time helpers for scheduled prompts — kept pure so they're cheap to unit test
// and reused by the composer pills, the mini-label and the sidebar list.

// Coarse countdown to a future fireAt, Turkish units: "~27 dk" / "~3 sa" / "~2 g".
// Rounds up to at least 1 minute so an imminent prompt never reads "0 dk".
export function relativeUntil(fireAt, now) {
  const diff = fireAt - now;
  if (diff <= 0) return "şimdi";
  const mins = Math.max(1, Math.round(diff / 60000));
  if (mins < 60) return `~${mins} dk`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `~${hrs} sa`;
  return `~${Math.round(hrs / 24)} g`;
}

// Compact wall-clock label for a fired/past row: "dd.MM HH:mm".
export function formatFireAt(epochMs) {
  const d = new Date(epochMs);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Local value for a <input type="datetime-local"> (no seconds, no timezone).
export function toDatetimeLocal(epochMs) {
  const d = new Date(epochMs);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Tomorrow at 09:00 local (the "Yarın 09:00" quick chip).
export function nextMorning(now) {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}
