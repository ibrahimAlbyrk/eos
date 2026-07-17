import { useEffect, useRef } from "react";
import { useUi } from "../../state/ui.jsx";
import { useOriginPane } from "../../state/paneScope.js";
import { explorer } from "../../state/explorerStore.js";
import { flattenVisible } from "../../lib/explorerNodes.js";
import { parentDir } from "../../lib/explorerApi.js";

// Tree keyboard navigation for the docked Files panel. Armed only while the
// host pane is focused AND the panel region owns focus (FileViewer's ⌘F gate
// idiom) — a window-level listener without that gate would hijack arrows/
// Enter/Delete from the composer and every other pane. Also skipped when focus
// is in an input or the CodeMirror editor (rename/search/editing).
export function useExplorerKeys() {
  const ui = useUi();
  const paneId = useOriginPane() ?? ui.focusedLeafId;
  const enabled = paneId === ui.focusedLeafId && ui.focusedRegion === "panel";
  const openFileRef = useRef(ui.openFileViewer);
  openFileRef.current = ui.openFileViewer;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable || t.closest?.(".cm-editor"))) return;

      const st = explorer.getState();
      if (!st.root || st.search.results !== null) return;
      const list = flattenVisible(st.root, st.expanded, st.childrenCache).filter((n) => n.kind === "entry");
      if (list.length === 0) return;

      const sel = st.selection.anchor ?? [...st.selection.ids][0] ?? null;
      const idx = sel ? list.findIndex((n) => n.path === sel) : -1;
      const cur = idx >= 0 ? list[idx] : null;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          explorer.selectOnly((list[idx + 1] ?? list[0]).path);
          break;
        case "ArrowUp":
          e.preventDefault();
          explorer.selectOnly((idx <= 0 ? list[0] : list[idx - 1]).path);
          break;
        case "ArrowRight":
          if (cur?.type === "directory") {
            e.preventDefault();
            if (!st.expanded.has(cur.path)) explorer.toggleExpand(cur.path);
            else if (list[idx + 1] && list[idx + 1].depth > cur.depth) explorer.selectOnly(list[idx + 1].path);
          }
          break;
        case "ArrowLeft":
          if (cur) {
            e.preventDefault();
            if (cur.type === "directory" && st.expanded.has(cur.path)) explorer.toggleExpand(cur.path);
            else if (list.some((n) => n.path === parentDir(cur.path))) explorer.selectOnly(parentDir(cur.path));
          }
          break;
        case "Enter":
          if (cur) {
            e.preventDefault();
            if (cur.type === "directory") explorer.toggleExpand(cur.path);
            else openFileRef.current(cur.path);
          }
          break;
        case "F2":
          if (cur) { e.preventDefault(); explorer.startRename(cur.path); }
          break;
        case "Delete":
        case "Backspace": {
          const ids = [...st.selection.ids];
          if (ids.length) { e.preventDefault(); explorer.trashEntries(ids); }
          break;
        }
        default:
          if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
            e.preventDefault();
            explorer.setSelection(list.map((n) => n.path), st.selection.anchor);
          }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
