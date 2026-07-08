import { openTab, closeTab, switchTab } from "../../state/ptyPanelStore.js";

// Tab bar for ONE pane's PTY panel: pill tabs each with its own ×, a
// trailing "+" to open a new session, and a FAR-RIGHT × that closes the whole
// panel. Store actions are pane-keyed, so tabs/labels are this pane's only.
export function TerminalTabBar({ paneId, tabs, activeId, cwd, fullscreen, onToggleFullscreen, onClosePanel }) {
  return (
    <div className="pty-tabbar">
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
      <button
        className="pty-panel__fullscreen"
        onClick={onToggleFullscreen}
        aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen terminal"}
        title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
      >
        {fullscreen ? (
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 7H9V3M7 13V9H3M9 7l5-5M7 9l-5 5" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 3h4v4M7 13H3V9M8 8l5-5M8 8l-5 5" />
          </svg>
        )}
      </button>
      <button
        className="pty-panel__close"
        onClick={onClosePanel}
        aria-label="Close terminal panel"
        title="Close panel"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}
