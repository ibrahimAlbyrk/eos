import { useEffect } from "react";
import { useUi } from "../../state/ui.jsx";
import { api } from "../../api/client.js";
import { explorer, useExplorerRoot } from "../../state/explorerStore.js";
import { workerGitDir } from "../../lib/workerGitDir.js";
import { projectPathFor } from "../../lib/breadcrumb.js";
import { usePanelHost } from "../../state/panelHost.js";
import { PanelShell } from "../agents/panes/PanelShell.jsx";
import { ExplorerToolbar } from "./sidebar/ExplorerToolbar.jsx";
import { ExplorerSearch } from "./sidebar/ExplorerSearch.jsx";
import { FileTree } from "./tree/FileTree.jsx";
import { FilesContextMenu } from "./FilesContextMenu.jsx";
import { FolderPicker } from "./picker/FolderPicker.jsx";
import { useExplorerKeys } from "./useExplorerKeys.js";

// The explorer store is a module singleton shared by every Files-panel mount, so
// watches must only pause when the LAST panel unmounts.
let mounted = 0;

// Files tab of the single side panel: the explorer (toolbar / search / tree)
// only — opening a file adds its own `file:<path>` tab. Root seeds from the panel's `cwd` data or, when absent,
// the selected agent's worktree / project path (a Code view pane: its folder).
export function FilesPanel({ live }) {
  const ui = useUi();
  const host = usePanelHost();
  useExplorerKeys();
  const root = useExplorerRoot();

  const worker = (live?.workers ?? []).find((w) => w.id === ui.selectedId) ?? null;
  const agentDir = workerGitDir(worker) ?? projectPathFor(live?.workers ?? [], ui.selectedId);
  const cwd = ui.panelData?.files?.cwd
    ?? (host ? host.cwd : agentDir ?? ui.composer?.cwd)
    ?? null;
  useEffect(() => {
    explorer.ensureRoot(cwd);
  }, [cwd]);

  const openFolder = async () => {
    const r = await api.pickDirectory();
    if (r?.path) { explorer.setRoot(r.path); live?.refreshRecents?.(); }
  };

  useEffect(() => {
    mounted += 1;
    if (mounted === 1) explorer.resumeWatches();
    return () => {
      mounted -= 1;
      if (mounted === 0) explorer.pauseWatches();
    };
  }, []);

  // No folder open (and none to seed) → the shared empty-state recipe with an
  // Open folder ⌘O chip. Gated on `!cwd` too so a folder that will seed on mount
  // doesn't flash the empty state for a frame.
  if (!root && !cwd) {
    return (
      <PanelShell type="files">
        <div className="empty-state">
          <span className="empty-state__icon">
            <svg width="40" height="40" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"><path d="M2 4.4a1 1 0 0 1 1-1h2.8l1.3 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.4Z" /></svg>
          </span>
          <span className="empty-state__title">No folder open</span>
          <span className="empty-state__subtitle">Open a folder to browse files.</span>
          <button className="empty-state__action" onClick={openFolder}>
            Open folder<kbd>⌘O</kbd>
          </button>
        </div>
      </PanelShell>
    );
  }

  return (
    <PanelShell type="files">
      <ExplorerToolbar />
      <ExplorerSearch />
      <FileTree />
      <FilesContextMenu />
      <FolderPicker live={live} agentDir={agentDir} />
    </PanelShell>
  );
}
