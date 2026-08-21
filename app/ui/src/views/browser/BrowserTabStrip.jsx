import { openTab, closeTab, switchTab, setMuted } from "../../state/browserPanelStore.js";

// Tab strip for ONE pane's browser panel: favicon + title pills each with their
// own ×, plus a trailing "+" for a new tab. Rendered in the PanelShell header's
// title slot — same placement and pill idiom as the terminal panel's
// TerminalTabBar. Tab metadata (title/url/loading/favicon/audio) is the
// daemon's; the pane-keyed store mirrors it, so tabs are this pane's only.

// Speaker glyph: waves while the tab is making sound, a slash once it's muted —
// two distinct states, never the same icon recoloured.
function SpeakerIcon({ muted }) {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2.5 4.8 5.4H2.5v5.2h2.3L8 13.5v-11z" />
      {muted ? <path d="m10.8 6.2 3.2 3.6M14 6.2l-3.2 3.6" /> : <path d="M10.9 5.6a3.4 3.4 0 0 1 0 4.8M12.9 3.6a6.2 6.2 0 0 1 0 8.8" />}
    </svg>
  );
}

export function BrowserTabStrip({ paneId, tabs, activeTabId }) {
  return (
    <div className="browser-tabs">
      {tabs.map((t) => {
        const label = t.title || t.url || "New tab";
        const isActive = t.tabId === activeTabId;
        return (
          <div
            key={t.tabId}
            className={"browser-tab" + (isActive ? " is-active" : "") + (t.loading ? " is-loading" : "") + (t.audible ? " is-audible" : "") + (t.muted ? " is-muted" : "")}
            onClick={() => switchTab(paneId, t.tabId)}
            title={t.url || label}
          >
            <span className="browser-tab__icon">
              {t.faviconDataUri ? (
                <img src={t.faviconDataUri} alt="" width="12" height="12" />
              ) : (
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                  <circle cx="8" cy="8" r="6" /><ellipse cx="8" cy="8" rx="2.6" ry="6" /><path d="M2.4 6h11.2M2.4 10h11.2" />
                </svg>
              )}
            </span>
            <span className="browser-tab__label">{label}</span>
            {/* Always rendered so a tab the daemon hasn't heard yet can still be
                silenced; CSS reveals it on hover, or whenever it is lit. */}
            <button
              className="browser-tab__audio"
              onClick={(e) => { e.stopPropagation(); setMuted(paneId, t.tabId, !t.muted); }}
              aria-label={`${t.muted ? "Unmute" : "Mute"} ${label}`}
              aria-pressed={Boolean(t.muted)}
              title={t.muted ? "Unmute tab" : "Mute tab"}
            >
              <SpeakerIcon muted={t.muted} />
            </button>
            <button
              className="browser-tab__close"
              onClick={(e) => { e.stopPropagation(); closeTab(paneId, t.tabId); }}
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
      <button className="browser-tab__add" onClick={() => openTab(paneId)} aria-label="New tab" title="New tab">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M8 3v10M3 8h10" />
        </svg>
      </button>
    </div>
  );
}
