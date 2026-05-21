import { memo } from "react";
import { fmtCost, fmtElapsed } from "../lib/format.js";
import { ThemeToggle } from "./ThemeToggle.jsx";

export const Topbar = memo(function Topbar({ agents, session, online, sessionName }) {
  const running = agents.filter(a => a.status === "running" || a.status === "thinking").length;
  const elapsedMs = session?.sessionStartTs ? Date.now() - session.sessionStartTs : 0;
  return (
    <header className="vb-topbar">
      <div className="vb-topbar__brand">
        <div className="vb-logomark">
          <img src="./logo.png" alt="Claude Manager" />
        </div>
        <div className="vb-topbar__brand-text">
          <div className="vb-topbar__brand-name">Claude Manager</div>
          <div className="vb-topbar__brand-sub">
            <span>{sessionName}</span>
            <span className="vb-topbar__brand-sep">·</span>
            <span className="vb-mono">v0.5</span>
          </div>
        </div>
      </div>

      <div className="vb-topbar__right">
        <div className="vb-headerstats">
          <div className="vb-headerstat">
            <div className="vb-headerstat__label">running</div>
            <div className="vb-headerstat__value">
              <span className="vb-live-dot" />
              {running}
            </div>
          </div>
          <div className="vb-headerstat">
            <div className="vb-headerstat__label">cost/h</div>
            <div className="vb-headerstat__value">{fmtCost(session?.costPerHour || 0)}</div>
          </div>
          <div className="vb-headerstat">
            <div className="vb-headerstat__label">elapsed</div>
            <div className="vb-headerstat__value vb-mono">{fmtElapsed(elapsedMs)}</div>
          </div>
        </div>
        {!online && (
          <div className="vb-headerstat" style={{ color: "var(--vb-err)", padding: "4px 10px", border: "1px solid rgba(217,126,126,0.4)", borderRadius: 8, background: "rgba(217,126,126,0.08)" }}>
            <div className="vb-headerstat__label" style={{ color: "var(--vb-err)" }}>daemon</div>
            <div className="vb-headerstat__value" style={{ color: "var(--vb-err)" }}>offline</div>
          </div>
        )}
        <ThemeToggle />
      </div>
    </header>
  );
});
