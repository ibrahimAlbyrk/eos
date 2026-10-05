// Shared subscription-usage formatting + row derivation. Used by the Settings
// "Usage" pane (settings/UsageSettings.jsx) and the context popover's "Plan
// usage limits" section (views/agents/popovers/CtxPopover.jsx) so the two never
// drift. Data source is GET /api/usage (utilization normalized 0–100, resetsAt
// ISO); the daemon owns the upstream cache + 180s floor.

export const WARN_THRESHOLD = 80; // ≥ this utilization tints the bar with the warn color

// Claude grades each limit itself (severity "normal" or worse); a plan that
// doesn't falls back to the 80% line.
export function isUsageWarn(window) {
  return window.severity ? window.severity !== "normal" : window.utilization >= WARN_THRESHOLD;
}

// "$12.34" — usage-credit amounts arrive in major units of the plan's currency.
export function formatCredits(amount, currency = "USD") {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
}

// Map a raw provider error reason (GET /api/usage errors[].reason) to a short,
// human message for the Usage pane. The scope failure means an older Eos sign-in
// (a setup-token) that runs agents but lacks the `user:profile` scope the usage
// endpoint requires; signing in again stores a full login. Every other reason
// collapses to a one-liner; the raw reason can carry a JSON error body, which is
// never shown to the user.
export function friendlyUsageError(reason) {
  if (reason && /user:profile|scope requirement|permission_error/i.test(reason)) {
    return "Your Claude sign-in runs agents but can't read plan usage. Sign out and sign in again in Settings › Accounts to see usage here.";
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

// "2h 41m" — formatResetIn for tight spots (the Account menu's usage rings).
export function formatResetInShort(iso) {
  return formatResetIn(iso).replace(" hr", "h").replace(" min", "m");
}

// "Tue 8:59 AM" — weekday + local time (the weekly subtitle).
export function formatResetAt(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = d.toLocaleDateString(undefined, { weekday: "short" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day} ${time}`;
}

// The plan behind each usage provider id, as the user knows it.
export const USAGE_PROVIDER_NAMES = { claude: "Claude", codex: "ChatGPT" };

// The account (GET /api/accounts id) each usage provider id reports on.
export const USAGE_PROVIDER_ACCOUNTS = { claude: "anthropic", codex: "openai" };

const WINDOW_ROWS = [
  { key: "fiveHour", label: "5-hour limit", short: "5-hour", kind: "session" },
  { key: "sevenDay", label: "Weekly · all models", short: "Weekly", kind: "weekly" },
];

// A model's own weekly limit (e.g. Fable), listed after the shared windows.
const modelRow = (window) => ({
  key: `model:${window.model}`, label: `Weekly · ${window.model}`, short: `Weekly ${window.model}`, kind: "weekly", window,
});

// One section per signed-in plan in a GET /api/usage response — its name, plan
// and limit rows. A plan with no windows to show is left out, so a glance
// surface can render the list as-is (empty = nothing to show). `kind` picks the
// reset formatter: "session" → relative, "weekly" → weekday + time.
export function planUsageSections(usage) {
  return (usage?.providers ?? [])
    .map((p) => {
      const w = p.windows ?? {};
      return {
        provider: p.provider,
        name: USAGE_PROVIDER_NAMES[p.provider] ?? p.provider,
        plan: p.plan ?? null,
        rows: [
          ...WINDOW_ROWS.map((r) => ({ ...r, window: w[r.key] })).filter((r) => r.window),
          ...(w.weeklyByModel ?? []).map(modelRow),
        ],
      };
    })
    .filter((s) => s.rows.length > 0);
}

// A row's reset line — "Resets in 2 hr 41 min" (session) / "Resets Tue 8:59 AM"
// (weekly), or "Not started" while the window has no usage and so no reset yet.
// `short` is the Account menu's compact form ("in 2h 41m" / "Tue 8:59 AM").
export function formatRowReset(row, { short = false } = {}) {
  const { resetsAt } = row.window;
  if (!resetsAt) return short ? "not started" : "Not started";
  if (row.kind === "session") return short ? `in ${formatResetInShort(resetsAt)}` : `Resets in ${formatResetIn(resetsAt)}`;
  return short ? formatResetAt(resetsAt) : `Resets ${formatResetAt(resetsAt)}`;
}

// A provider "error" that only means you aren't signed in to that plan — nothing
// to show, not a failure.
export function isSignedOutReason(reason) {
  return /subscription token|not signed in/i.test(reason ?? "");
}
