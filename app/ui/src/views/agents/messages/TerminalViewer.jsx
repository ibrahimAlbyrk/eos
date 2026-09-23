import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useUi } from "../../../state/ui.jsx";
import { projectPathFor } from "../../../lib/breadcrumb.js";
import { sessionRootOf } from "../../../lib/agentIndex.js";
import { subscribe, getPtyPanel, openTab, reapUntrackedSessions } from "../../../state/ptyPanelStore.js";
import { PanelShell } from "../panes/PanelShell.jsx";
import { TerminalView } from "../../../components/terminal/TerminalView.jsx";

// Terminal docked-panel viewer — one of the pane's right-side island panels
// (chrome via the shared PanelShell). A SINGLE terminal, no inner tab strip
// (matching the reference): the panel body is just the xterm host. Mounted
// whenever "terminal" is in this pane's panel stack.
//
// Lifecycle: the session PERSISTS — closing/hiding the panel or switching agents
// no longer kills it. On mount it reaps only server sessions no pane tracks, then
// REATTACHES to the pane's existing session (kept by the pane-keyed ptyPanelStore
// across unmount); only when the pane has none does it spawn one fresh (in the
// selected orchestrator's project path). TerminalView replays its session's
// scrollback buffer on remount.
// One PTY session per top-level Terminal tab: the pane store key combines the
// selected agent's session root (terminals stay per-project) with the tab id, so
// each "Terminal N" pill owns an independent session. SidePanel uses the same
// helper to kill that session when its tab is closed.
export function terminalPaneKey(root, tabId) {
  return tabId ? `${root}::${tabId}` : root;
}

export function TerminalViewer({ live, tabId }) {
  const ui = useUi();
  // undefined (not null) when unknown, so it's dropped from the POST body.
  const cwd = projectPathFor(live?.workers ?? [], ui.selectedId) ?? undefined;
  const root = sessionRootOf(ui.selectedId) ?? "global";
  return <TerminalViewerInner paneId={terminalPaneKey(root, tabId)} cwd={cwd} />;
}

function TerminalViewerInner({ paneId, cwd }) {
  const { tabs, activeId } = useSyncExternalStore(
    useCallback((cb) => subscribe(paneId, cb), [paneId]),
    useCallback(() => getPtyPanel(paneId), [paneId]),
  );
  // Latest selected-project cwd, read at open-time only — switching orchestrators
  // never retro-changes already-open tabs; the next new tab picks up the change.
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  // Reap sessions no pane tracks (boot clean-slate after an app quit), then
  // REATTACH: a pane whose tabs survived the unmount keeps them — only open a
  // fresh Terminal when the pane is empty. `cancelled` guards against a fast
  // unmount/remount double-opening (skip the open if torn down mid-reap); an
  // in-flight open that completes after unmount is fine — its session persists
  // and the next mount reattaches to it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await reapUntrackedSessions();
      if (cancelled) return;
      if (getPtyPanel(paneId).tabs.length === 0) {
        await openTab(paneId, { cwd: cwdRef.current });
      }
    })();
    return () => { cancelled = true; };
  }, [paneId]);

  return (
    <PanelShell type="terminal">
      <div className="pty-body">
        {tabs.map((t) => (
          <TerminalView key={t.sessionId} sessionId={t.sessionId} active={t.sessionId === activeId} />
        ))}
      </div>
    </PanelShell>
  );
}
