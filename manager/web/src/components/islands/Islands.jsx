import { useUi } from "../../state/ui.jsx";
import { fmtCost, fmtElapsed, fmtTokens, statusFromState } from "../../lib/format.js";
import { contextUsage } from "../../lib/contextWindow.js";

export function Islands({ live }) {
  const ui = useUi();
  const selected = live.workers.find((w) => w.id === ui.selectedId);
  // Always render the .islands container so the adjacent-sibling CSS
  // combinator (.islands.hidden + .island-handle) can find it; toggle the
  // .hidden class instead. When no agent is selected, also hide.
  const hidden = ui.islandsHidden || !selected;
  if (!selected) {
    return <div className="islands hidden" id="islands" />;
  }

  const status = statusFromState(selected.state);
  const elapsedMs = (selected.ended_at ?? live.now) - (selected.started_at ?? live.now);
  const { used: ctxUsed } = contextUsage(selected, selected.model, live.lastUsage);

  return (
    <div className={"islands" + (hidden ? " hidden" : "")} id="islands">
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
        <defs>
          <linearGradient id="ring-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#6ea4e8" />
            <stop offset="100%" stopColor="#8ab9f0" />
          </linearGradient>
        </defs>
      </svg>

      <div className="isl isl-header">
        <button className="close-btn" title="Close" onClick={() => ui.setIslandsHidden(true)}>
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
        <span className="live-eyebrow">
          <span className="pulse"></span>
          live · {fmtElapsed(elapsedMs)}
        </span>
        <div className="agent-name">{selected.name || (selected.is_orchestrator ? "Orchestrator" : selected.id)}</div>
        <div className="agent-meta">
          <span className="model-badge">{selected.model || "—"}</span>
          <span className="status-text">● {status.label}</span>
        </div>
      </div>

      <div className="duo-row">
        <div className="isl isl-tile" title="Estimated API-equivalent cost. If you use a Max/Pro subscription, no actual money is charged.">
          <div className="lab">cost</div>
          <div className="val">{fmtCost(selected.cost_usd ?? 0)}</div>
        </div>
        <div className="isl isl-tile">
          <div className="lab">elapsed</div>
          <div className="val">{fmtElapsed(elapsedMs)}</div>
        </div>
      </div>

      <div className="isl isl-tokens">
        <div className="lab">tokens</div>
        <div className="stack">
          <div className="val">{fmtTokens(ctxUsed)}</div>
          <div className="breakdown">
            <span><b>{fmtTokens(selected.tokens_in ?? 0)}</b> in</span>
            <span>·</span>
            <span><b>{fmtTokens(selected.tokens_out ?? 0)}</b> out</span>
          </div>
        </div>
      </div>

      <div className="isl isl-tools">
        <span className="lab">activity</span>
        <span className="total">{selected.tool_calls ?? 0} <span className="word">tool calls</span></span>
      </div>
    </div>
  );
}
