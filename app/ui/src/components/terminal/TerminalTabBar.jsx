import { openTab, closeTab, switchTab } from "../../state/ptyPanelStore.js";

// Tab bar for the PTY panel: pill tabs each with its own ×, a
// trailing "+" to open a new session, and a FAR-RIGHT × that closes the whole
// panel (sessions persist — panel-close never kills a PTY).
export function TerminalTabBar({ tabs, activeId, cwd, onClosePanel }) {
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
              onClick={() => switchTab(t.sessionId)}
              title={label}
            >
              <span className="pty-tab__label">{label}</span>
              <button
                className="pty-tab__close"
                onClick={(e) => { e.stopPropagation(); closeTab(t.sessionId, { cwd }); }}
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
        <button className="pty-tab__add" onClick={() => openTab({ cwd })} aria-label="New terminal" title="New terminal">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
      </div>
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
