import { createPortal } from "react-dom";
import { useUi } from "../../state/ui.jsx";
import { api } from "../../api/client.js";
import { notify } from "../../lib/notify.js";
import { explorer } from "../../state/explorerStore.js";
import { parentDir } from "../../lib/explorerApi.js";

// Right-click menu for tree rows. Reads ui.popoverData.paths (the selection at
// click time). Mirrors AgentContextMenu: a positioned .ctx-menu with
// data-popover so the shared outside-click/Escape plumbing dismisses it.
// Portal'd to <body> because the panel lives inside a contain:paint pane,
// which would otherwise clip the fixed menu (GitDiffFileMenu idiom).
export function FilesContextMenu() {
  const ui = useUi();
  if (ui.openPopover !== "fx-ctx") return null;
  const paths = ui.popoverData?.paths ?? [];
  const files = ui.popoverData?.files ?? [];
  if (paths.length === 0) return null;

  const primary = paths[0];
  const single = paths.length === 1;
  const st = explorer.getState();
  const primaryIsDir = st.childrenCache.has(primary) || st.expanded.has(primary);
  const targetDir = single && primaryIsDir ? primary : parentDir(primary);

  const close = () => ui.closeAllPops();
  const act = (fn) => { fn(); close(); };

  const open = () => act(() => (primaryIsDir ? explorer.toggleExpand(primary) : ui.openFileViewer(primary)));
  const rename = () => act(() => explorer.startRename(primary));
  const reveal = () => act(() => api.revealFile(primary));
  const copyPath = async () => {
    await navigator.clipboard?.writeText(paths.join("\n"));
    notify.info(paths.length > 1 ? `${paths.length} paths copied` : 'Path copied');
    close();
  };
  const newFile = () => act(() => explorer.startDraft(targetDir, "file"));
  const newFolder = () => act(() => explorer.startDraft(targetDir, "directory"));
  const del = () => act(() => explorer.trashEntries(paths));
  // Queue an @ mention insert for the focused pane's composer (this pane —
  // the right-click already focused it). Same singleton idiom as pendingText.
  const attach = () => act(() => ui.updateComposer({ pendingMention: { paths: files, ts: Date.now() } }));

  const left = Math.min(ui.popoverPos.x, window.innerWidth - 210);
  const top = Math.min(ui.popoverPos.y, window.innerHeight - 280);

  const Item = ({ onClick, danger, kbd, children }) => (
    <button className={"menu-item" + (danger ? " danger" : "")} onClick={onClick}>
      {children}{kbd && <span className="kbd">{kbd}</span>}
    </button>
  );

  return createPortal(
    <div className="ctx-menu glass-pop open" data-popover="fx-ctx" style={{ display: "block", left, top }}>
      {single && <Item onClick={open}>Open<span className="kbd">⏎</span></Item>}
      {single && <Item onClick={reveal}>Reveal in Finder</Item>}
      {single && <div className="menu-sep" />}
      {single && <Item onClick={rename} kbd="F2">Rename</Item>}
      {files.length > 0 && <Item onClick={attach}>{files.length > 1 ? `Attach ${files.length} as context` : "Attach as context"}</Item>}
      <Item onClick={copyPath}>{single ? "Copy path" : `Copy ${paths.length} paths`}</Item>
      <div className="menu-sep" />
      <Item onClick={newFile}>New File</Item>
      <Item onClick={newFolder}>New Folder</Item>
      <div className="menu-sep" />
      <Item onClick={del} danger kbd="⌫">{single ? "Delete" : `Delete ${paths.length} items`}</Item>
    </div>,
    document.body,
  );
}
