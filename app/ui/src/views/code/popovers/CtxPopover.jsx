import { useUi } from "../../../state/ui.jsx";
import { fmtCost, fmtTokens } from "../../../lib/format.js";
import { backendBilled } from "../../../lib/backendCaps.js";

export function CtxPopover({ used, total, pct, costUsd, totalCostUsd, backendKind }) {
  const ui = useUi();
  if (ui.openPopover !== "ctx") return null;
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
