import { useEffect } from "react";
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

// Code — a terminal workspace: split panes, each running Claude Code (or a
// plain shell) in the chosen folder.
export function CodeView({ live }) {
  const ws = useCodeWorkspace();
  useCodeHotkeys();

  // Drop panes whose session died while this view wasn't mounted.
  useEffect(() => { reconcile(); }, []);

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
    <AppLayout
      gridClass={leafCount(ws.tree) > 1 ? "split" : ""}
      sidebar={(variant) => <CodeSidebar live={live} variant={variant} />}
      main={<TermGrid live={live} ws={ws} />}
    />
  );
}
