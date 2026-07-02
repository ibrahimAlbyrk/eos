import { useUi } from "../../state/ui.jsx";
import { explorer } from "../../state/explorerStore.js";

// Right-click menu inside the editor, on an identifier. Mirrors FilesContextMenu:
// a positioned .ctx-menu with data-popover so the shared outside-click plumbing
// dismisses it. popoverData carries the { word, path } the editor resolved.
export function SymbolContextMenu() {
  const ui = useUi();
  if (ui.openPopover !== "fx-sym-ctx") return null;
  const word = ui.popoverData?.word;
  const path = ui.popoverData?.path;
  if (!word) return null;

  const close = () => ui.closeAllPops();
  const act = (fn) => { fn(); close(); };
  const goToDef = () => act(() => explorer.goToDefinition(word, path));
  const findRefs = () => act(() => explorer.findReferences(word, path));

  const left = Math.min(ui.popoverPos.x, window.innerWidth - 220);
  const top = Math.min(ui.popoverPos.y, window.innerHeight - 140);

  return (
    <div className="ctx-menu glass-pop open" data-popover="fx-sym-ctx" style={{ display: "block", left, top }}>
      <div className="menu-head"><b>{word}</b></div>
      <button className="menu-item" onClick={goToDef}>Go to definition</button>
      <button className="menu-item" onClick={findRefs}>Find references</button>
    </div>
  );
}
