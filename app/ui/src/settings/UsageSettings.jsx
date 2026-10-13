// Usage panel — the Settings "Usage" tab. Shows every signed-in plan's limits
// (Claude, ChatGPT…: 5-hour session + weekly windows) as thin progress bars with
// reset times, one group per plan, styled to match Claude's own usage screen
// using the existing settings tokens/classes. Read-only: it loads GET /api/usage on open through
// state/usageStore.js (the daemon owns the cache + 180s upstream floor) and offers a
// manual refresh that just re-hits the same route. A failed refresh keeps the last
// data on screen and says so in the footer.
//
// Custom Component (no registry `groups`), like AccountsSettings/RemoteSettings —
// it owns no settings.json keys (the data is fetched live, never persisted).

import { loadUsage, useUsage } from "../state/usageStore.js";
import {
  USAGE_PROVIDER_NAMES, formatCredits, formatRowReset, friendlyUsageError, isSignedOutReason, isUsageWarn, planUsageSections,
} from "../lib/usageFormat.js";

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

function UsageBar({ pct, warn }) {
  const clamped = Math.max(0, Math.min(100, pct));
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

function UsageRow({ label, subtitle, pct, warn }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <div className="stg-row__label">{label}</div>
        <div className="stg-row__label" style={{ fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
          {Math.round(pct)}% used
        </div>
      </div>
      {subtitle && <div className="stg-row__desc">{subtitle}</div>}
      <UsageBar pct={pct} warn={warn} />
    </div>
  );
}

export function UsageSettings() {
  // data: undefined = loading, null = transport fail with nothing to show
  const { usage: data, loading: busy, unreachable, now } = useUsage();

  const sections = planUsageSections(data, now);
  const providerOf = (id) => data?.providers?.find((p) => p.provider === id);
  // A plan you aren't signed in to is simply absent — only real failures (an
  // upstream/scope error on a plan you ARE signed in to) are shown, mapped to a
  // human one-liner (never the raw JSON body). A plan still showing its last
  // data only gets the footer note.
  const failures = (data?.errors ?? [])
    .filter((e) => !isSignedOutReason(e.reason) && !sections.some((sec) => sec.provider === e.provider));
  const outdated = unreachable || sections.some((sec) => sec.stale);
  const signedOut = data && !sections.length && !failures.length;
  const lastUpdated = sections
    .map((sec) => providerOf(sec.provider)?.fetchedAt)
    .filter(Boolean)
    .sort()
    .at(0);

  return (
    <>
      <h2 className="stg-title">Usage</h2>

      {data === undefined && <div className="stg-row__desc">Loading usage…</div>}

      {data === null && (
        <div className="stg-group">
          <div className="stg-row stg-row--stack">
            <div className="stg-prov-err">Couldn’t reach the daemon to load usage.</div>
          </div>
          <button type="button" className="stg-prov-save" disabled={busy} onClick={loadUsage}>
            {busy ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}

      {signedOut && (
        <div className="stg-group">
          <div className="stg-row stg-row--stack">
            <div className="stg-row__desc">
              You're not signed in to a plan, so usage can’t be shown.
              Sign in under <strong>Accounts</strong> to see your limits.
            </div>
          </div>
        </div>
      )}

      {sections.map((section) => {
        const extra = providerOf(section.provider)?.extraUsage;
        const credits = (amount) => formatCredits(amount ?? 0, extra.currency);
        return (
          <div className="stg-group" key={section.provider}>
            <div className="stg-group__title">
              {section.name}{section.plan ? ` · ${section.plan}` : ""}
            </div>
            {section.rows.map((r) => (
              <UsageRow
                key={r.key}
                label={r.kind === "session" ? "Current session" : r.label}
                subtitle={formatRowReset(r)}
                pct={r.window.utilization}
                warn={isUsageWarn(r.window)}
              />
            ))}
            {extra?.isEnabled && (
              <div className="stg-row">
                <div className="stg-row__text">
                  <div className="stg-row__label">Usage credits</div>
                  <div className="stg-row__desc">
                    {extra.monthlyLimit != null
                      ? `${credits(extra.usedCredits)} of ${credits(extra.monthlyLimit)} monthly limit`
                      : `${credits(extra.usedCredits)} used`}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {failures.length > 0 && (
        <div className="stg-group">
          {failures.map((e) => (
            <div className="stg-row stg-row--stack" key={e.provider}>
              <div className="stg-prov-err">
                {USAGE_PROVIDER_NAMES[e.provider] ?? e.provider}: {friendlyUsageError(e.reason)}
              </div>
            </div>
          ))}
          {!sections.length && (
            <button type="button" className="stg-prov-save" disabled={busy} onClick={loadUsage}>
              {busy ? "Refreshing…" : "Try again"}
            </button>
          )}
        </div>
      )}

      {sections.length > 0 && (
        <div
          className="stg-row"
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}
        >
          <span className="stg-row__desc">
            Last updated: {formatAgo(lastUpdated)}{outdated ? " · couldn’t refresh, retrying" : ""}
          </span>
          <button type="button" className="stg-prov-save" disabled={busy} onClick={loadUsage}>
            {busy ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      )}
    </>
  );
}
