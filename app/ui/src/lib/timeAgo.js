// "just now" · "5m ago" · "3h ago" · "2d ago" — a quiet last-seen / last-synced label.
export function timeAgo(ts, now = Date.now()) {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
