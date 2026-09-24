import { useEffect, useMemo } from "react";
import { useGlobalKeymap } from "../../keymap/useKeymap.js";
import { keymap, combo } from "../../keymap/index.js";
import { isTerminalFocused } from "../../components/terminal/terminalBridge.js";
import { AppLayout } from "../../components/layout/AppLayout.jsx";
import { leafCount } from "../../lib/paneLayout.js";
import {
  KINDS, openTerminal, splitPane, closePane, focusPaneByIndex, reconcile, setCwd, clearCwd, getWorkspace,
} from "../../state/codeWorkspaceStore.js";
import { useCodeWorkspace } from "./useCodeWorkspace.js";
import { CodeSidebar } from "./sidebar/CodeSidebar.jsx";
import { TermGrid } from "./TermGrid.jsx";
import { projectFolders } from "./FolderMenu.jsx";
import { api } from "../../api/client.js";
import { useUi } from "../../state/ui.jsx";
import { PaneScopeContext } from "../../state/paneScope.js";
import { PanelHostContext } from "../../state/panelHost.js";
import { SidePanel } from "../agents/panes/SidePanel.jsx";

// The view's single right side panel is keyed under this id in the per-pane
// panel state, so it stays put whichever terminal pane is focused. Its tabs skip
// the agent-bound ones (Chat files, Review) — nothing to show here.
const PANEL_ID = "code";
const PANEL_TABS = ["terminal", "files", "browser"];

// Workspace hotkeys. All terminalSafe — in this view the terminal IS the
// focus — and each stops the event so the key never also reaches xterm.
const HOTKEYS = [
  { keys: "mod+t", run: () => openTerminal(KINDS.claude) },
  { keys: "mod+shift+t", run: () => openTerminal(KINDS.shell) },
  { keys: "mod+d", run: () => splitFocused("row") },
  { keys: "mod+shift+d", run: () => splitFocused("col") },
  { keys: "mod+w", run: () => closePane(getWorkspace().focusedId) },
];

function splitFocused(dir) {
  const { focusedId, terms } = getWorkspace();
  splitPane(focusedId, dir, terms[focusedId]?.kind ?? KINDS.claude);
}

function useCodeHotkeys() {
  useGlobalKeymap(() => ({ terminalFocused: isTerminalFocused() }));
  useEffect(() => {
    const bindings = HOTKEYS.map(({ keys, run }) => ({ match: combo(keys), run }));
    // ⌘1..9 → focus the Nth pane.
    bindings.push({
      match: (e) => e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code),
      run: (e) => focusPaneByIndex(Number(e.code.slice(5)) - 1),
    });
    const offs = bindings.map(({ match, run }) => keymap.register({
      terminalSafe: true,
      match,
      run: (ctx, e) => { e.preventDefault(); e.stopPropagation(); run(e); },
    }));
    return () => offs.forEach((off) => off());
  }, []);
}

// Mounted only while the view is shown: the view itself stays mounted in the
// background, and its bindings (⌘W, ⌘T, ⌘1..9) must not fire over Agents.
function CodeHotkeys() {
  useCodeHotkeys();
  return null;
}

// Code — a terminal workspace: split panes, each running Claude Code (or a
// plain shell) in the chosen folder. Kept mounted while another view is shown
// (views/registry.js); `active` says whether it's the one on screen.
export function CodeView({ live, active }) {
  const ws = useCodeWorkspace();

  // Drop panes whose session died while this view wasn't shown.
  useEffect(() => { if (active) reconcile(); }, [active]);

  // A remembered folder that was deleted since can't host a session — drop it
  // so the default below falls back to an existing one. A network failure
  // (TypeError) says nothing about the folder, so it's kept.
  useEffect(() => {
    const cwd = ws.cwd;
    if (!cwd) return;
    api.statPath(cwd)
      .then((s) => { if (s?.type !== "directory") clearCwd(cwd); })
      .catch((e) => { if (!(e instanceof TypeError)) clearCwd(cwd); });
  }, [ws.cwd]);

  // First run: default the folder to the most recent one.
  useEffect(() => {
    const first = projectFolders(live.recents)[0];
    if (!ws.cwd && first) setCwd(first);
  }, [ws.cwd, live.recents]);

  return (
    <>
      {active && <CodeHotkeys />}
      <AppLayout
        hidden={!active}
        gridClass={leafCount(ws.tree) > 1 ? "split" : ""}
        sidebar={(variant) => <CodeSidebar live={live} variant={variant} />}
        main={<CodeMain live={live} ws={ws} active={active} />}
      />
    </>
  );
}

// Terminal grid + the one side panel docked at the far right. The panel works in
// the focused pane's folder; its terminals stay one set for the whole view.
function CodeMain({ live, ws, active }) {
  const cwd = ws.terms[ws.focusedId]?.cwd ?? ws.cwd ?? null;
  const host = useMemo(() => ({ key: PANEL_ID, cwd }), [cwd]);
  return (
    <PaneScopeContext.Provider value={PANEL_ID}>
      <PanelHostContext.Provider value={host}>
        <CodeMainBody live={live} ws={ws} active={active} />
      </PanelHostContext.Provider>
    </PaneScopeContext.Provider>
  );
}

// While hidden the grid's terminals pause but stay mounted; the side panel
// unmounts instead — its browser drives the app's single native view, which a
// hidden copy would fight with the Agents view's panel.
function CodeMainBody({ live, ws, active }) {
  const ui = useUi();
  return (
    <div className={"cw-main sp-host" + (ui.showSidePanel ? " is-panel-open" : "")}>
      <TermGrid live={live} ws={ws} paused={!active} />
      {active && <SidePanel live={live} tabs={PANEL_TABS} />}
    </div>
  );
}
