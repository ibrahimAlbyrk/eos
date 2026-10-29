import { useEffect, useState } from "react";

// Minimize / maximize / close, drawn by the app where the shell gives the window
// no system controls (Windows: <html data-os="windows">, shell bridge eosWindow).
// Fixed at the top-right like NativeToggleZone at the top-left; the top-right
// pane header leaves their width free (.pane-head--topright).
function MinimizeGlyph() {
  return <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><line x1="1" y1="5" x2="9" y2="5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /></svg>;
}

function MaximizeGlyph({ maximized }) {
  return maximized ? (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true">
      <rect x="1" y="3" width="6" height="6" rx="1.4" />
      <path d="M3 3V2.4A1.4 1.4 0 0 1 4.4 1H7.6A1.4 1.4 0 0 1 9 2.4V5.6A1.4 1.4 0 0 1 7.6 7H7" />
    </svg>
  ) : (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true"><rect x="1" y="1" width="8" height="8" rx="1.6" /></svg>
  );
}

function CloseGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" aria-hidden="true">
      <line x1="1.5" y1="1.5" x2="8.5" y2="8.5" />
      <line x1="8.5" y1="1.5" x2="1.5" y2="8.5" />
    </svg>
  );
}

export function WindowControls() {
  const bridge = typeof window !== "undefined" ? window.eosWindow : undefined;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!bridge) return undefined;
    void bridge.isMaximized().then(setMaximized);
    return bridge.onMaximizedChange(setMaximized);
  }, [bridge]);

  if (!bridge) return null;
  return (
    <div className="window-controls">
      <button type="button" className="wc-btn" onClick={() => bridge.minimize()} title="Minimize" aria-label="Minimize"><MinimizeGlyph /></button>
      <button type="button" className="wc-btn" onClick={() => bridge.toggleMaximize()} title={maximized ? "Restore" : "Maximize"} aria-label={maximized ? "Restore" : "Maximize"}><MaximizeGlyph maximized={maximized} /></button>
      <button type="button" className="wc-btn wc-close" onClick={() => bridge.close()} title="Close" aria-label="Close"><CloseGlyph /></button>
    </div>
  );
}
