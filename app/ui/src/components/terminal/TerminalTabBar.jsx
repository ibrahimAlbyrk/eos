import { openTab, closeTab, switchTab } from "../../state/ptyPanelStore.js";

// Tab strip for ONE pane's PTY panel: pill tabs each with its own ×, plus a
// trailing "+" to open a new session. Rendered in the PanelShell header's title
// slot — the shell owns the surrounding chrome (fullscreen toggle, panel ×).
// Store actions are pane-keyed, so tabs/labels are this pane's only.
export function TerminalTabBar({ paneId, tabs, activeId, cwd }) {
  return (
    <div className="pty-tabs">
      {tabs.map((t) => {
        const isActive = t.sessionId === activeId;
        const label = tabs.length === 1 ? "Terminal" : `Terminal ${t.number}`;
        return (
          <div
            key={t.sessionId}
            className={"pty-tab" + (isActive ? " is-active" : "") + (t.exited ? " is-exited" : "")}
            onClick={() => switchTab(paneId, t.sessionId)}
            title={label}
          >
            <span className="pty-tab__label">{label}</span>
            <button
              className="pty-tab__close"
              onClick={(e) => { e.stopPropagation(); closeTab(paneId, t.sessionId, { cwd }); }}
              aria-label={`Close ${label}`}
              title="Close tab"
            >
              <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        );
      })}
      <button className="pty-tab__add" onClick={() => openTab(paneId, { cwd })} aria-label="New terminal" title="New terminal">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M8 3v10M3 8h10" />
        </svg>
      </button>
    </div>
  );
}
