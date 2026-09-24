import { Fragment, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api/client.js";
import { fmtCost } from "../lib/format.js";
import { WARN_THRESHOLD, formatResetIn, formatResetAt, planUsageRows } from "../lib/usageFormat.js";

// Subscription "Plan usage" — the same GET /api/usage data the Settings Usage
// pane shows, as compact label · meter · % rows (one shared grid so the meters
// line up). Returns null while loading or when there's no Claude token / no
// windows / a transport error — the menu is a glance surface, not an error one.
export function PlanUsage({ usage }) {
  const section = planUsageRows(usage);
  if (!section) return null;
  return (
    <div className="acct-usage">
      <div className="acct-usage-head">
        <span>Plan usage</span>
        {section.plan && <span className="acct-plan">{section.plan}</span>}
      </div>
      {section.rows.map((r) => {
        const pct = Math.round(r.window.utilization);
        const warn = pct >= WARN_THRESHOLD ? " is-warn" : "";
        const reset =
          r.kind === "session"
            ? `Resets in ${formatResetIn(r.window.resetsAt)}`
            : `Resets ${formatResetAt(r.window.resetsAt)}`;
        return (
          <Fragment key={r.key}>
            <span className="acct-limit-label">{r.label}</span>
            <span className={"usage-meter" + warn}><i style={{ width: pct + "%" }} /></span>
            <span className={"acct-limit-pct" + warn}>{pct}%</span>
            <span className="acct-limit-reset">{reset}</span>
          </Fragment>
        );
      })}
    </div>
  );
}

// Opened from the sidebar's Account row: plan usage + total cost across agents,
// then Settings. Fixed above the row (`anchor` = its rect) and portal'd to
// <body>; data-popover keeps clicks inside it "inside" for the outside-click
// handler. Mounted only while open, so usage is fetched per open (the daemon
// caches upstream with a 180s floor).
export function AccountMenu({ anchor, totalCostUsd, onOpenSettings }) {
  const [usage, setUsage] = useState(undefined); // undefined = loading, null = none/error

  useEffect(() => {
    let alive = true;
    api.getUsage()
      .then((res) => { if (alive) setUsage(res); })
      .catch(() => { if (alive) setUsage(null); });
    return () => { alive = false; };
  }, []);

  const pos = { left: Math.round(anchor.left + 8), bottom: Math.round(window.innerHeight - anchor.top + 6) };

  return createPortal(
    <div className="acct-menu" data-popover="account-menu" role="menu" aria-label="Account" style={pos}>
      <PlanUsage usage={usage} />
      <div
        className="acct-total"
        title="Estimated API-equivalent cost across all agents. If you use a Max/Pro subscription, no actual money is charged."
      >
        <span>Total cost · all agents</span>
        <b>{fmtCost(totalCostUsd)}</b>
      </div>
      <div className="acct-sep" />
      <button className="acct-item" role="menuitem" onClick={() => onOpenSettings()}>
        Settings<span className="acct-kbd">⌘,</span>
      </button>
      <button className="acct-item" role="menuitem" onClick={() => onOpenSettings("usage")}>
        Usage details
      </button>
    </div>,
    document.body,
  );
}
