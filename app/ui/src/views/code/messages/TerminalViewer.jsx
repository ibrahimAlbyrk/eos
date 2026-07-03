import { useEffect, useRef, useSyncExternalStore } from "react";
import { useUi } from "../../../state/ui.jsx";
import { projectPathFor } from "../../../lib/breadcrumb.js";
import { subscribe, getPtyPanel, openTab, killAllSessions } from "../../../state/ptyPanelStore.js";
import { TerminalTabBar } from "../../../components/terminal/TerminalTabBar.jsx";
import { TerminalView } from "../../../components/terminal/TerminalView.jsx";

// Terminal docked-panel viewer — one of the pane's right-side island panels
// (same chrome/geometry as FileViewer/DiffViewer et al; see styles.css .file-
// viewer list). Mounted whenever "terminal" is in this pane's panel stack; only
// visible (tv-open) when it's the top panel.
//
// Lifecycle: ALWAYS opens clean — on mount it kills any stale server sessions,
// then spawns one fresh tab (in the selected orchestrator's project path).
// Closing the panel (far-right ×) terminates every session. No reattach/replay.
export function TerminalViewer({ live }) {
  const ui = useUi();
  const open = !!ui.terminalViewer;
  // undefined (not null) when unknown, so it's dropped from the POST body.
  const cwd = projectPathFor(live?.workers ?? [], ui.selectedId) ?? undefined;
  const closePanel = () => { killAllSessions(); ui.closeTerminalViewer(); };
  return (
    <div className={"terminal-viewer" + (ui.topPanelType === "terminal" ? " tv-open" : "")}>
      {open && <TerminalViewerInner cwd={cwd} onClosePanel={closePanel} />}
    </div>
  );
}

function TerminalViewerInner({ cwd, onClosePanel }) {
  const { tabs, activeId } = useSyncExternalStore(subscribe, getPtyPanel);
  // Latest selected-project cwd, read at open-time only — switching orchestrators
  // never retro-changes already-open tabs; the next new tab picks up the change.
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  // Clean open: reap any stale server sessions (e.g. app quit while open), then
  // spawn one fresh Terminal in the selected project path.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await killAllSessions();
      if (cancelled) return;
      await openTab({ cwd: cwdRef.current });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="pty-panel">
      <TerminalTabBar tabs={tabs} activeId={activeId} cwd={cwd} onClosePanel={onClosePanel} />
      <div className="pty-body">
        {tabs.map((t) => (
          <TerminalView key={t.sessionId} sessionId={t.sessionId} active={t.sessionId === activeId} />
        ))}
      </div>
    </div>
  );
}
