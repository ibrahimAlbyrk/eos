import { useRef } from "react";
import { createPortal } from "react-dom";
import { useUi } from "../../../state/ui.jsx";
import { contextUsage } from "../../../lib/contextWindow.js";
import { fmtCost, fmtTokens } from "../../../lib/format.js";
import { backendBilled } from "../../../lib/backendCaps.js";
import { WARN_THRESHOLD } from "../../../lib/usageFormat.js";

// Context chip — the agent's context-window fill as a hairline meter + "38%"
// beside the breadcrumb: quiet until asked. Click opens a small card with the
// token count and this session's cost. Portal'd like PlanChip (the crumb clips,
// split panes paint-contain). Account-wide plan limits live in the sidebar's
// Account menu, not here — they aren't about this agent.
export function ContextChip({ worker }) {
  const ui = useUi();
  const ref = useRef(null);
  const open = ui.openPopover === "ctx";

  const { used, total, pct } = contextUsage(worker, worker.model);
  const warn = pct >= WARN_THRESHOLD ? " is-warn" : "";

  const toggle = (e) => {
    e.stopPropagation();
    if (open) ui.closeAllPops();
    else ui.openPop("ctx");
  };

  const rect = open ? ref.current?.getBoundingClientRect() : null;
  const pos = rect && {
    top: Math.round(rect.bottom + 8),
    left: Math.round(Math.max(8, Math.min(rect.left - 6, window.innerWidth - 256))),
  };

  return (
    <>
      <button
        ref={ref}
        className={"ctx-chip" + warn + (open ? " on" : "")}
        onClick={toggle}
        data-popover-trigger="ctx"
        aria-expanded={open}
        aria-label={`Context window: ${pct}% used`}
      >
        <span className="usage-meter"><i style={{ width: pct + "%" }} /></span>
        <span className="ctx-chip-pct">{pct}%</span>
      </button>
      {pos && createPortal(
        <div className={"ctx-card" + warn} data-popover="ctx" role="dialog" aria-label="Context window" style={pos}>
          <div className="ctx-card-head">
            <span>Context</span>
            <span className="ctx-card-pct">{pct}<small>%</small></span>
          </div>
          <span className="usage-meter"><i style={{ width: pct + "%" }} /></span>
          <span className="ctx-card-sub"><b>{fmtTokens(used)}</b> of {fmtTokens(total)} tokens</span>
          <div
            className="ctx-card-cost"
            title="Estimated API-equivalent cost for this agent. If you use a Max/Pro subscription, no actual money is charged."
          >
            <span>Session · {backendBilled(worker.backend_kind) ? "billed" : "included"}</span>
            <b>{fmtCost(worker.cost_usd ?? 0)}</b>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
