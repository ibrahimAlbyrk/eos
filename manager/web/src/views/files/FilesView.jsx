import { useEffect } from "react";
import { useUi } from "../../state/ui.jsx";
import { AppLayout } from "../../components/layout/AppLayout.jsx";
import { explorer } from "../../state/explorerStore.js";
import { FilesSidebar } from "./sidebar/FilesSidebar.jsx";
import { ExplorerEditor } from "./ExplorerEditor.jsx";
import { FilesContextMenu } from "./FilesContextMenu.jsx";
import { FolderPicker } from "./picker/FolderPicker.jsx";
import { useExplorerKeys } from "./useExplorerKeys.js";

export function FilesView({ live }) {
  const ui = useUi();
  useExplorerKeys();

  // Seed the root once (last session, else the active agent's cwd). ensureRoot is
  // idempotent, so re-running as the selection resolves just fills a null root.
  useEffect(() => {
    const agent = live.workers.find((w) => w.id === ui.selectedId);
    explorer.ensureRoot(agent?.cwd ?? null);
  }, [ui.selectedId, live.workers]);

  // Release directory watches when the tab unmounts (debounced — survives quick
  // tab flips); re-arm on return.
  useEffect(() => {
    explorer.resumeWatches();
    return () => explorer.pauseWatches();
  }, []);

  // Outside-click closes the Files popovers (folder picker + context menu).
  useEffect(() => {
    if (!ui.openPopover) return;
    const handler = (e) => {
      const inside = e.target.closest(`[data-popover="${ui.openPopover}"]`)
        || e.target.closest(`[data-popover-trigger="${ui.openPopover}"]`);
      if (!inside) ui.closeAllPops();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [ui.openPopover, ui]);

  // Standard collapsible sidebar (tree) + center (editor) — same slots and the
  // same global 280px width as Code/Workflows.
  return (
    <AppLayout
      sidebar={(variant) => <FilesSidebar live={live} variant={variant} />}
      main={<ExplorerEditor />}
    >
      <FilesContextMenu />
      <FolderPicker live={live} />
    </AppLayout>
  );
}
