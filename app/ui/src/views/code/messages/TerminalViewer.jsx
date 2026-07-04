import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useUi } from "../../../state/ui.jsx";
import { projectPathFor } from "../../../lib/breadcrumb.js";
import { subscribe, getPtyPanel, openTab, killPaneSessions, reapUntrackedSessions } from "../../../state/ptyPanelStore.js";
import { TerminalTabBar } from "../../../components/terminal/TerminalTabBar.jsx";
import { TerminalView } from "../../../components/terminal/TerminalView.jsx";

// Terminal docked-panel viewer — one of the pane's right-side island panels
// (same chrome/geometry as FileViewer/DiffViewer et al; see styles.css .file-
// viewer list). Mounted whenever "terminal" is in this pane's panel stack; only
// visible (tv-open) when it's the top panel.
//
// Lifecycle: ALWAYS opens clean — on mount it reaps server sessions no pane
// tracks, then spawns one fresh tab (in the selected orchestrator's project
// path). Closing the panel terminates THIS pane's sessions only; each pane's
// terminal is independent (pane-keyed ptyPanelStore). No reattach/replay.
export function TerminalViewer({ live }) {
  const ui = useUi();
  const paneId = ui.paneId;
  const open = !!ui.terminalViewer;
  // undefined (not null) when unknown, so it's dropped from the POST body.
  const cwd = projectPathFor(live?.workers ?? [], ui.selectedId) ?? undefined;
  const closePanel = () => { killPaneSessions(paneId); ui.closeTerminalViewer(); };
  return (
    <div className="terminal-viewer tv-open">
      {open && <TerminalViewerInner paneId={paneId} cwd={cwd} onClosePanel={closePanel} />}
    </div>
  );
}

function TerminalViewerInner({ paneId, cwd, onClosePanel }) {
  const { tabs, activeId } = useSyncExternalStore(
    useCallback((cb) => subscribe(paneId, cb), [paneId]),
    useCallback(() => getPtyPanel(paneId), [paneId]),
  );
  // Latest selected-project cwd, read at open-time only — switching orchestrators
  // never retro-changes already-open tabs; the next new tab picks up the change.
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  // Clean open: reap sessions no pane tracks (e.g. app quit while open), then
  // spawn one fresh Terminal in the selected project path. The unmount kill
  // covers exits that skip the close click (pane removed, agent switch): nothing
  // else reaps tracked sessions, and there is no reattach path to preserve.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await reapUntrackedSessions();
      if (cancelled) return;
      await openTab(paneId, { cwd: cwdRef.current });
      if (cancelled) await killPaneSessions(paneId);
    })();
    return () => { cancelled = true; killPaneSessions(paneId); };
  }, [paneId]);

  return (
    <div className="pty-panel">
      <TerminalTabBar paneId={paneId} tabs={tabs} activeId={activeId} cwd={cwd} onClosePanel={onClosePanel} />
      <div className="pty-body">
        {tabs.map((t) => (
          <TerminalView key={t.sessionId} sessionId={t.sessionId} active={t.sessionId === activeId} />
        ))}
      </div>
    </div>
  );
}
