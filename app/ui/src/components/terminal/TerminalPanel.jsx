import { useEffect, useSyncExternalStore } from "react";
import { subscribe, getPtyPanel, openTab, reattach } from "../../state/ptyPanelStore.js";
import { TerminalTabBar } from "./TerminalTabBar.jsx";
import { TerminalView } from "./TerminalView.jsx";

// Panel shell docked in AppLayout's grid-column:3 slot: tab bar + the mounted
// TerminalViews (only the active one is visible; the rest stay mounted hidden so
// scrollback survives switches). On first open with no tabs it reattaches to any
// live server sessions, then opens a fresh Terminal if there are still none.
export function TerminalPanel() {
  const { tabs, activeId } = useSyncExternalStore(subscribe, getPtyPanel);

  useEffect(() => {
    let cancelled = false;
    if (tabs.length === 0) {
      (async () => {
        await reattach();
        if (cancelled) return;
        if (getPtyPanel().tabs.length === 0) await openTab();
      })();
    }
    return () => { cancelled = true; };
    // Run once on mount — the panel only mounts when opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="pty-panel">
      <TerminalTabBar tabs={tabs} activeId={activeId} />
      <div className="pty-body">
        {tabs.map((t) => (
          <TerminalView key={t.sessionId} sessionId={t.sessionId} active={t.sessionId === activeId} />
        ))}
      </div>
    </div>
  );
}
