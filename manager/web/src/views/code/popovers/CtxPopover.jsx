import { useUi } from "../../../state/ui.jsx";
import { fmtCost, fmtTokens } from "../../../lib/format.js";

export function CtxPopover({ used, total, pct, session }) {
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
      <div className="cp-row cp-foot" title="Estimated API-equivalent cost. If you use a Max/Pro subscription, no actual money is charged.">
        <span className="cp-label">Session cost</span>
        <span className="cp-value">{fmtCost(session?.totalCost ?? 0)}</span>
      </div>
    </div>
  );
}
