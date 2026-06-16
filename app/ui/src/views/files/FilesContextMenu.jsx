import { useUi } from "../../state/ui.jsx";
import { api } from "../../api/client.js";
import { explorer } from "../../state/explorerStore.js";
import { parentDir } from "../../lib/explorerApi.js";

// Right-click menu for tree rows. Reads ui.popoverData.paths (the selection at
// click time). Mirrors AgentContextMenu: a positioned .ctx-menu with
// data-popover so the shared outside-click/Escape plumbing dismisses it.
export function FilesContextMenu() {
  const ui = useUi();
  if (ui.openPopover !== "fx-ctx") return null;
  const paths = ui.popoverData?.paths ?? [];
  if (paths.length === 0) return null;

  const primary = paths[0];
  const single = paths.length === 1;
  const st = explorer.getState();
  const primaryIsDir = st.childrenCache.has(primary) || st.expanded.has(primary);
  const targetDir = single && primaryIsDir ? primary : parentDir(primary);

  const close = () => ui.closeAllPops();
  const act = (fn) => { fn(); close(); };

  const open = () => act(() => (primaryIsDir ? explorer.toggleExpand(primary) : explorer.openFilePath(primary)));
  const rename = () => act(() => explorer.startRename(primary));
  const reveal = () => act(() => api.revealFile(primary));
  const copyPath = () => act(() => navigator.clipboard?.writeText(paths.join("\n")));
  const newFile = () => act(() => explorer.startDraft(targetDir, "file"));
  const newFolder = () => act(() => explorer.startDraft(targetDir, "directory"));
  const del = () => act(() => explorer.trashEntries(paths));

  const left = Math.min(ui.popoverPos.x, window.innerWidth - 210);
  const top = Math.min(ui.popoverPos.y, window.innerHeight - 280);

  const Item = ({ onClick, danger, kbd, children }) => (
    <button className={"menu-item" + (danger ? " danger" : "")} onClick={onClick}>
      {children}{kbd && <span className="kbd">{kbd}</span>}
    </button>
  );

  return (
    <div className="ctx-menu glass-pop open" data-popover="fx-ctx" style={{ display: "block", left, top }}>
      {single && <Item onClick={open}>Open<span className="kbd">⏎</span></Item>}
      {single && <Item onClick={reveal}>Reveal in Finder</Item>}
      {single && <div className="menu-sep" />}
      {single && <Item onClick={rename} kbd="F2">Rename</Item>}
      <Item onClick={copyPath}>{single ? "Copy path" : `Copy ${paths.length} paths`}</Item>
      <div className="menu-sep" />
      <Item onClick={newFile}>New File</Item>
      <Item onClick={newFolder}>New Folder</Item>
      <div className="menu-sep" />
      <Item onClick={del} danger kbd="⌫">{single ? "Delete" : `Delete ${paths.length} items`}</Item>
    </div>
  );
}
