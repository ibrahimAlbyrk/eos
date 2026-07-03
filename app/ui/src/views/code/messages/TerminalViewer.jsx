import { useEffect, useSyncExternalStore } from "react";
import { useUi } from "../../../state/ui.jsx";
import { subscribe, getPtyPanel, openTab, reattach } from "../../../state/ptyPanelStore.js";
import { TerminalTabBar } from "../../../components/terminal/TerminalTabBar.jsx";
import { TerminalView } from "../../../components/terminal/TerminalView.jsx";

// Terminal docked-panel viewer — one of the pane's right-side island panels
// (same chrome/geometry as FileViewer/DiffViewer et al; see styles.css .file-
// viewer list). Mounted whenever "terminal" is in this pane's panel stack; only
// visible (tv-open) when it's the top panel. The interior is the embedded PTY
// terminal exactly as before (uniform bg tab bar + xterm bodies).
export function TerminalViewer() {
  const ui = useUi();
  const open = !!ui.terminalViewer;
  return (
    <div className={"terminal-viewer" + (ui.topPanelType === "terminal" ? " tv-open" : "")}>
      {open && <TerminalViewerInner onClosePanel={ui.closeTerminalViewer} />}
    </div>
  );
}

function TerminalViewerInner({ onClosePanel }) {
  const { tabs, activeId } = useSyncExternalStore(subscribe, getPtyPanel);

  // On first mount with no tabs, reattach to live server sessions, then open a
  // fresh Terminal if there are still none (panel never shows zero tabs).
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="pty-panel">
      <TerminalTabBar tabs={tabs} activeId={activeId} onClosePanel={onClosePanel} />
      <div className="pty-body">
        {tabs.map((t) => (
          <TerminalView key={t.sessionId} sessionId={t.sessionId} active={t.sessionId === activeId} fresh={t.fresh} />
        ))}
      </div>
    </div>
  );
}
