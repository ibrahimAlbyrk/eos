import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useUi } from "../../../state/ui.jsx";
import { projectPathFor } from "../../../lib/breadcrumb.js";
import { subscribe, getPtyPanel, openTab, reapUntrackedSessions } from "../../../state/ptyPanelStore.js";
import { PanelShell } from "../panes/PanelShell.jsx";
import { TerminalTabBar } from "../../../components/terminal/TerminalTabBar.jsx";
import { TerminalView } from "../../../components/terminal/TerminalView.jsx";

// Terminal docked-panel viewer — one of the pane's right-side island panels
// (chrome via the shared PanelShell; the tab strip rides the shell header's
// title slot). Mounted whenever "terminal" is in this pane's panel stack.
//
// Lifecycle: sessions PERSIST — closing/hiding the panel or switching agents no
// longer kills them. On mount it reaps only server sessions no pane tracks, then
// REATTACHES to the pane's existing tabs (kept by the pane-keyed ptyPanelStore
// across unmount); only when the pane has zero tabs does it spawn one fresh tab
// (in the selected orchestrator's project path). Each TerminalView replays its
// session's scrollback buffer on remount.
export function TerminalViewer({ live }) {
  const ui = useUi();
  // undefined (not null) when unknown, so it's dropped from the POST body.
  const cwd = projectPathFor(live?.workers ?? [], ui.selectedId) ?? undefined;
  if (!ui.terminalViewer) return <PanelShell type="terminal" />;
  return <TerminalViewerInner paneId={ui.paneId} cwd={cwd} />;
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
    <PanelShell type="terminal" title={<TerminalTabBar paneId={paneId} tabs={tabs} activeId={activeId} cwd={cwd} />}>
      <div className="pty-body">
        {tabs.map((t) => (
          <TerminalView key={t.sessionId} sessionId={t.sessionId} active={t.sessionId === activeId} />
        ))}
      </div>
    </PanelShell>
  );
}
