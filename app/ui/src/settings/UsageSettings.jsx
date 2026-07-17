// Usage panel — the Settings "Usage" tab. Shows the Claude subscription's plan
// limits (5-hour session + weekly windows) as thin progress bars with reset
// times, styled to match Claude's own usage screen using the existing settings
// tokens/classes. Read-only: it fetches GET /api/usage on open (the daemon owns
// the cache + 180s upstream floor) and offers a manual refresh that just re-hits
// the same route.
//
// Custom Component (no registry `groups`), like AnthropicSettings/RemoteSettings —
// it owns no settings.json keys (the data is fetched live, never persisted).

import { useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";
import { WARN_THRESHOLD, formatResetIn, formatResetAt, friendlyUsageError } from "../lib/usageFormat.js";

export const USAGE_SETTING_DEFAULTS = {};

// "just now" / "3 min ago" / "2 hr ago" for the last-updated footer.
function formatAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  if (ms < 45_000) return "just now";
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  return new Date(iso).toLocaleDateString();
}

function UsageBar({ pct }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const warn = clamped >= WARN_THRESHOLD;
  return (
    <div style={{ height: 6, borderRadius: 999, background: "var(--surface-3)", overflow: "hidden" }}>
      <div
        style={{
          width: `${clamped}%`,
          height: "100%",
          borderRadius: 999,
          background: warn ? "var(--warn)" : "var(--accent)",
          transition: "width .3s ease",
        }}
      />
    </div>
  );
}

function UsageRow({ label, subtitle, pct }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <div className="stg-row__label">{label}</div>
        <div className="stg-row__label" style={{ fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
          {Math.round(pct)}% used
        </div>
      </div>
      {subtitle && <div className="stg-row__desc">{subtitle}</div>}
      <UsageBar pct={pct} />
    </div>
  );
}

export function UsageSettings() {
  const [data, setData] = useState(undefined); // undefined = loading, null = transport fail
  const [busy, setBusy] = useState(false);
  const loaded = useRef(false);

  const load = () => {
    setBusy(true);
    api.getUsage()
      .then((res) => setData(res))
      .catch(() => setData(null))
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    load();
  }, []);

  const claude = data?.providers?.find((p) => p.provider === "claude") ?? data?.providers?.[0];
  const errors = data?.errors ?? [];
  // A missing token is a quiet hint, not an error — distinguished from a real
  // upstream/scope failure ("OAuth token …") by the "subscription token" phrase.
  const noToken = !claude && errors.some((e) => /subscription token/i.test(e.reason));
  // Map the raw upstream reason (may be a scope error or a JSON body) to a human
  // one-liner — never surface the raw JSON dump.
  const errorReason = !claude && !noToken && errors.length ? friendlyUsageError(errors[0]?.reason) : null;

  const windows = claude?.windows ?? {};
  const weekly = [
    ["All models", windows.sevenDay],
    ["Opus", windows.sevenDayOpus],
    ["Sonnet", windows.sevenDaySonnet],
  ].filter(([, w]) => w);

  return (
    <>
      <h2 className="stg-title">Usage</h2>

      {data === undefined && <div className="stg-row__desc">Loading usage…</div>}

      {data === null && (
        <div className="stg-group">
          <div className="stg-row stg-row--stack">
            <div className="stg-prov-err">Couldn’t reach the daemon to load usage.</div>
          </div>
          <button type="button" className="stg-prov-save" disabled={busy} onClick={load}>
            {busy ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}

      {noToken && (
        <div className="stg-group">
          <div className="stg-row stg-row--stack">
            <div className="stg-row__desc">
              No Claude subscription token is configured, so plan usage can’t be shown.
              Add your OAuth token in the <strong>Anthropic</strong> settings to see your limits.
            </div>
          </div>
        </div>
      )}

      {errorReason && (
        <div className="stg-group">
          <div className="stg-row stg-row--stack">
            <div className="stg-prov-err">{errorReason}</div>
          </div>
          <button type="button" className="stg-prov-save" disabled={busy} onClick={load}>
            {busy ? "Refreshing…" : "Try again"}
          </button>
        </div>
      )}

      {claude && (
        <>
          <div className="stg-group">
            <div className="stg-group__title">
              Plan usage limits{claude.plan ? ` · ${claude.plan}` : ""}
            </div>
            {windows.fiveHour ? (
              <UsageRow
                label="Current session"
                subtitle={`Resets in ${formatResetIn(windows.fiveHour.resetsAt)}`}
                pct={windows.fiveHour.utilization}
              />
            ) : (
              <div className="stg-row__desc">No active session window.</div>
            )}
          </div>

          {weekly.length > 0 && (
            <div className="stg-group">
              <div className="stg-group__title">Weekly limits</div>
              {weekly.map(([label, w]) => (
                <UsageRow
                  key={label}
                  label={label}
                  subtitle={`Resets ${formatResetAt(w.resetsAt)}`}
                  pct={w.utilization}
                />
              ))}
            </div>
          )}

          {claude.extraUsage?.isEnabled && (
            <div className="stg-group">
              <div className="stg-group__title">Usage credits</div>
              <div className="stg-row">
                <div className="stg-row__text">
                  <div className="stg-row__label">Credits used</div>
                  <div className="stg-row__desc">
                    {claude.extraUsage.monthlyLimit != null
                      ? `${claude.extraUsage.usedCredits ?? 0} of ${claude.extraUsage.monthlyLimit} monthly limit`
                      : `${claude.extraUsage.usedCredits ?? 0} used`}
                  </div>
                </div>
              </div>
            </div>
          )}

          <div
            className="stg-row"
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}
          >
            <span className="stg-row__desc">Last updated: {formatAgo(claude.fetchedAt)}</span>
            <button type="button" className="stg-prov-save" disabled={busy} onClick={load}>
              {busy ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </>
      )}
    </>
  );
}
