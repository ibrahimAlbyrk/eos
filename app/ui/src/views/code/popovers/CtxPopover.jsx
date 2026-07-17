import { useEffect, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { fmtCost, fmtTokens } from "../../../lib/format.js";
import { backendBilled } from "../../../lib/backendCaps.js";
import { WARN_THRESHOLD, formatResetIn, formatResetAt, planUsageRows } from "../../../lib/usageFormat.js";

// Subscription "Plan usage limits" — the same GET /api/usage data the Settings
// Usage pane shows, rendered as compact glance rows under the context window.
// Returns null (section omitted silently) while loading or when there's no
// Claude token / no windows / a transport error — the popover is a glance
// surface, not an error surface.
export function PlanUsageLimits({ usage, onOpenSettings }) {
  const section = planUsageRows(usage);
  if (!section) return null;
  return (
    <>
      <div className="cp-divider"></div>
      <div className="cp-row cp-section">
        <span className="cp-label">Plan usage limits{section.plan ? ` · ${section.plan}` : ""}</span>
        {onOpenSettings && (
          <button
            type="button"
            className="cp-arrow"
            style={{ marginLeft: "auto", background: "none", border: 0, padding: "0 2px", cursor: "pointer" }}
            onClick={onOpenSettings}
            title="Open Usage settings"
            aria-label="Open Usage settings"
          >
            →
          </button>
        )}
      </div>
      {section.rows.map((r) => {
        const pct = Math.round(r.window.utilization);
        const warn = pct >= WARN_THRESHOLD;
        const reset =
          r.kind === "session"
            ? `Resets in ${formatResetIn(r.window.resetsAt)}`
            : `Resets ${formatResetAt(r.window.resetsAt)}`;
        return (
          <div key={r.key}>
            <div className="cp-row cp-context">
              <span className="cp-label">{r.label}</span>
              <span className="cp-value">
                <span style={{ color: "var(--fg-faint)", marginRight: 8 }}>{reset}</span>
                {pct}
                <span className="cp-pct">%</span>
              </span>
            </div>
            <div className="cp-context-bar-wrap">
              <div className="cp-context-bar">
                <i style={{ width: pct + "%", background: warn ? "var(--warn)" : undefined }}></i>
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

export function CtxPopover({ used, total, pct, costUsd, totalCostUsd, backendKind }) {
  const ui = useUi();
  const open = ui.openPopover === "ctx";
  const [usage, setUsage] = useState(undefined); // undefined = loading, null = none/error

  // Fetch on open (the daemon caches upstream with a 180s floor, so re-fetching
  // per open is safe); null on transport failure hides the section.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api.getUsage()
      .then((res) => { if (alive) setUsage(res); })
      .catch(() => { if (alive) setUsage(null); });
    return () => { alive = false; };
  }, [open]);

  if (!open) return null;
  return (
    <div className="ctx-popover open" id="ctxPopover" role="dialog" aria-label="Context usage" data-popover="ctx">
      <div className="cp-row cp-context">
        <span className="cp-label">Context window</span>
        <span className="cp-value">
          {fmtTokens(used)} / {fmtTokens(total)} <span className="cp-pct">({pct}%)</span>
        </span>
      </div>
      <div className="cp-context-bar-wrap">
        <div className="cp-context-bar"><i style={{ width: pct + "%" }}></i></div>
      </div>
      <PlanUsageLimits
        usage={usage}
        onOpenSettings={ui.openSettings ? () => { ui.openSettings("usage"); ui.closeAllPops?.(); } : undefined}
      />
      <div className="cp-divider"></div>
      <div className="cp-row cp-foot cp-costs">
        <span className="cp-cost" title="Estimated API-equivalent cost for this agent. If you use a Max/Pro subscription, no actual money is charged.">
          <span className="cp-label">Session cost{backendKind ? ` · ${backendBilled(backendKind) ? "billed" : "included"}` : ""}</span>
          <span className="cp-cost-val">{fmtCost(costUsd)}</span>
        </span>
        <span className="cp-cost" title="Estimated API-equivalent cost across all agents. If you use a Max/Pro subscription, no actual money is charged.">
          <span className="cp-label">Total cost</span>
          <span className="cp-cost-val">{fmtCost(totalCostUsd)}</span>
        </span>
      </div>
    </div>
  );
}
