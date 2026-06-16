import { useEffect } from "react";
import { explorer } from "../../state/explorerStore.js";
import { flattenVisible } from "../../lib/explorerNodes.js";
import { parentDir } from "../../lib/explorerApi.js";

// Tree keyboard navigation, scoped to when focus is NOT in an input or the
// CodeMirror editor (so it never steals keys from rename/search/editing).
// Selection changes drive the scroll-into-view effect in FileTree.
export function useExplorerKeys() {
  useEffect(() => {
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
            else explorer.openFilePath(cur.path);
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
  }, []);
}
