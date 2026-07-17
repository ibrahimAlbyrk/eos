// Shared subscription-usage formatting + row derivation. Used by the Settings
// "Usage" pane (settings/UsageSettings.jsx) and the context popover's "Plan
// usage limits" section (views/code/popovers/CtxPopover.jsx) so the two never
// drift. Data source is GET /api/usage (utilization normalized 0–100, resetsAt
// ISO); the daemon owns the upstream cache + 180s floor.

export const WARN_THRESHOLD = 80; // ≥ this utilization tints the bar with the warn color

// Map a raw provider error reason (GET /api/usage errors[].reason) to a short,
// human message for the Usage pane. The scope failure is the common one: the token
// configured in Settings › Anthropic lacks the `user:profile` scope the usage
// endpoint requires, so usage needs the Claude Code login token (Keychain) — a
// re-login via `claude /login`. Every other reason collapses to a one-liner; the
// raw reason can carry a JSON error body, which is never shown to the user.
export function friendlyUsageError(reason) {
  if (reason && /user:profile|scope requirement|permission_error/i.test(reason)) {
    return "The Anthropic token in Settings lacks the user:profile scope needed for usage. Sign in with the Claude Code login (run `claude /login`) so the Keychain token is used.";
  }
  return "Couldn’t load usage right now. Please try again in a moment.";
}

// "2 hr 41 min" left until the window resets (relative — the session subtitle).
export function formatResetIn(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "now";
  const totalMin = Math.round(ms / 60000);
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (hr <= 0) return `${min} min`;
  return min > 0 ? `${hr} hr ${min} min` : `${hr} hr`;
}

// "Tue 8:59 AM" — weekday + local time (the weekly subtitle).
export function formatResetAt(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = d.toLocaleDateString(undefined, { weekday: "short" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day} ${time}`;
}

// Derive the compact "Plan usage limits" rows for the context popover from a
// GET /api/usage response. Returns null when there's nothing to show (no Claude
// provider, or every window is null) so the caller can omit the section
// silently — the popover is a glance surface, not an error surface. `kind`
// picks the reset formatter: "session" → relative, "weekly" → weekday + time.
export function planUsageRows(usage) {
  const claude = usage?.providers?.find((p) => p.provider === "claude") ?? usage?.providers?.[0];
  if (!claude) return null;
  const w = claude.windows ?? {};
  const rows = [
    { key: "fiveHour", label: "5-hour limit", kind: "session", window: w.fiveHour },
    { key: "sevenDay", label: "Weekly · all models", kind: "weekly", window: w.sevenDay },
    { key: "sevenDayOpus", label: "Weekly · Opus", kind: "weekly", window: w.sevenDayOpus },
    { key: "sevenDaySonnet", label: "Weekly · Sonnet", kind: "weekly", window: w.sevenDaySonnet },
  ].filter((r) => r.window);
  if (rows.length === 0) return null;
  return { plan: claude.plan ?? null, rows };
}
