import { useEffect } from "react";
import { useUi } from "../../state/ui.jsx";
import { explorer } from "../../state/explorerStore.js";
import { PanelShell } from "../code/panes/PanelShell.jsx";
import { ExplorerToolbar } from "./sidebar/ExplorerToolbar.jsx";
import { ExplorerSearch } from "./sidebar/ExplorerSearch.jsx";
import { FileTree } from "./tree/FileTree.jsx";
import { FilesContextMenu } from "./FilesContextMenu.jsx";
import { FolderPicker } from "./picker/FolderPicker.jsx";
import { useExplorerKeys } from "./useExplorerKeys.js";

// The explorer store is a module singleton shared by every pane's Files panel,
// so watches must only pause when the LAST panel unmounts — a plain per-mount
// cleanup would drop the other pane's live tree.
let mounted = 0;

// Docked Files panel: the explorer toolbar/search/tree in the right-panel dock.
// Opening a file routes through the scoped ui.openFileViewer, so it lands in
// THIS pane's existing "file" editor panel. The context menu + folder picker
// portal to <body> (panes contain paint).
export function FilesPanel({ live }) {
  const ui = useUi();
  useExplorerKeys();

  // Seed the root once from the dir the panel was opened on (last session's
  // root wins when present). ensureRoot is idempotent.
  const cwd = ui.filesViewer?.cwd ?? null;
  useEffect(() => {
    explorer.ensureRoot(cwd);
  }, [cwd]);

  // Mirror the durable "show hidden files" setting (daemon-persisted, survives
  // app restarts) into the explorer store.
  useEffect(() => {
    explorer.setShowHidden(ui.settings?.filesShowHidden === true);
  }, [ui.settings?.filesShowHidden]);

  useEffect(() => {
    mounted += 1;
    if (mounted === 1) explorer.resumeWatches();
    return () => {
      mounted -= 1;
      if (mounted === 0) explorer.pauseWatches();
    };
  }, []);

  return (
    <PanelShell type="files">
      <ExplorerToolbar />
      <ExplorerSearch />
      <FileTree />
      <FilesContextMenu />
      <FolderPicker live={live} />
    </PanelShell>
  );
}
