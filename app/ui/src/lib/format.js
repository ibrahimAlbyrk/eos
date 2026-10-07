// Pure formatters used across the UI.

export function fmtCost(n) {
  if (n == null) return "$0.00";
  return "$" + Number(n).toFixed(n >= 1 ? 2 : 3);
}

export function fmtElapsed(ms) {
  if (!ms || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

// Compact elapsed format used inside in-line progress indicators where
// fmtElapsed's "00:03" zero-padding looks heavier than needed.
//   1234ms → "1s"
//   72_000 → "1m 12s"
//   3661000 → "1h 1m"
export function fmtElapsedShort(ms) {
  if (!ms || ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Compact relative timestamp for tight rows (sidebar): "now", "5m", "1w".
export function fmtTimeAgoShort(ts, now = Date.now()) {
  const s = Math.floor((now - ts) / 1000);
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  if (d < 30) return `${Math.floor(d / 7)}w`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
}

// Relative timestamp for message hover rows: "just now", "5m ago", "1w ago".
export function fmtTimeAgo(ts, now = Date.now()) {
  const short = fmtTimeAgoShort(ts, now);
  return short === "now" ? "just now" : `${short} ago`;
}

// Transcript date divider: { day: "Thu, Sep 24", time: "7:53 PM" }; the year
// joins the day only when it isn't the current one.
export function fmtDayStamp(ts, now = Date.now()) {
  const d = new Date(ts);
  const year = d.getFullYear() !== new Date(now).getFullYear() ? "numeric" : undefined;
  return {
    day: d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year }),
    time: d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
  };
}

export function fmtTokens(n) {
  if (!n) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

export function modelShort(model) {
  if (!model) return "—";
  return String(model).replace(/^claude-/, "");
}

export function statusFromState(state) {
  switch (state) {
    case "WORKING":  return { dot: "run",   label: "running" };
    // Boot is part of the turn — surfacing "spawning" reads as slowness, so
    // the UI presents it as already running. (FSM state is untouched.)
    case "SPAWNING": return { dot: "run",   label: "running" };
    case "IDLE":     return { dot: "wait",  label: "idle" };
    case "ENDING":   return { dot: "wait",  label: "ending" };
    case "DONE":     return { dot: "wait",  label: "done" };
    case "KILLING":  return { dot: "queue", label: "killing" };
    // Process dead but resumable — a message transparently revives it, so
    // the user just sees "idle"; the distinction is an implementation detail.
    case "SUSPENDED": return { dot: "wait", label: "idle" };
    // Drafts haven't been spawned yet, but the UI treats them as idle/ready
    // so the user doesn't get the impression the agent failed to start.
    case "DRAFT":    return { dot: "wait",  label: "idle" };
    default:         return { dot: "wait",  label: String(state || "idle").toLowerCase() };
  }
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
