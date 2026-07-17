import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import {
  explorer, useChildrenCache, useDraft, useExpanded,
  useExplorerRoot, useRenaming, useSearchMode,
  useSearchState, useSelection,
} from "../../../state/explorerStore.js";
import { flattenVisible } from "../../../lib/explorerNodes.js";
import { isDescendant, parentDir } from "../../../lib/explorerApi.js";
import { FileRow } from "./FileRow.jsx";
import { FileIcon } from "../FileIcon.jsx";
import { SymbolSearchList } from "../SymbolResults.jsx";
import { RenameInput } from "../../../components/RenameInput.jsx";

export function FileTree() {
  const ui = useUi();
  const root = useExplorerRoot();
  const expanded = useExpanded();
  const cache = useChildrenCache();
  const selection = useSelection();
  const search = useSearchState();
  const searchMode = useSearchMode();
  const openPath = ui.fileViewer?.path ?? null;
  const draft = useDraft();
  const renaming = useRenaming();

  const inSearch = search.results !== null;
  const visible = useMemo(
    () => (inSearch ? [] : flattenVisible(root, expanded, cache)),
    [inSearch, root, expanded, cache],
  );

  const [dropTarget, setDropTarget] = useState(null);
  const treeRef = useRef(null);

  // Keep the keyboard-/external-selected row in view (changes to selection.anchor
  // come from clicks AND useExplorerKeys).
  useEffect(() => {
    if (!selection.anchor || inSearch) return;
    treeRef.current?.querySelector(`[data-fx-path="${CSS.escape(selection.anchor)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selection.anchor, inSearch]);

  // Refs so the stable handlers below read the latest state without changing
  // identity (keeps FileRow's memo effective on large trees).
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const selRef = useRef(selection); selRef.current = selection;
  const dragRef = useRef([]);
  const openPopRef = useRef(ui.openPop); openPopRef.current = ui.openPop;
  const openFileRef = useRef(ui.openFileViewer); openFileRef.current = ui.openFileViewer;

  const activate = useCallback((node) => {
    if (node.type === "directory") explorer.toggleExpand(node.path);
    else openFileRef.current(node.path);
  }, []);

  const onRowClick = useCallback((path, e) => {
    const list = visibleRef.current.filter((n) => n.kind === "entry");
    if (e.metaKey || e.ctrlKey) { explorer.toggleSelect(path); return; }
    const anchor = selRef.current.anchor;
    if (e.shiftKey && anchor) {
      const a = list.findIndex((n) => n.path === anchor);
      const b = list.findIndex((n) => n.path === path);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        explorer.setSelection(list.slice(lo, hi + 1).map((n) => n.path), anchor);
        return;
      }
    }
    explorer.selectOnly(path);
    const node = list.find((n) => n.path === path);
    if (node) activate(node);
  }, [activate]);

  const onContext = useCallback((path, e) => {
    e.preventDefault();
    if (!selRef.current.ids.has(path)) explorer.selectOnly(path);
    const paths = selRef.current.ids.has(path) && selRef.current.ids.size > 0 ? [...selRef.current.ids] : [path];
    // The plain-file subset, for "Attach as context" (the @ flow attaches only
    // files, never directories). Context menus open on tree rows only, so every
    // selected path resolves in the visible list.
    const entries = visibleRef.current.filter((n) => n.kind === "entry");
    const files = paths.filter((p) => entries.find((n) => n.path === p)?.type === "file");
    openPopRef.current("fx-ctx", { x: e.clientX, y: e.clientY, data: { paths, files } });
  }, []);

  const onDragStart = useCallback((path, e) => {
    dragRef.current = selRef.current.ids.has(path) ? [...selRef.current.ids] : [path];
    e.dataTransfer.setData("application/x-eos-files", JSON.stringify(dragRef.current));
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const onDragOver = useCallback((dir, e) => {
    const drags = dragRef.current;
    const ok = drags.length > 0 && drags.every((p) => !isDescendant(p, dir) && parentDir(p) !== dir);
    if (!ok) { e.dataTransfer.dropEffect = "none"; return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTarget(dir);
  }, []);

  const onDragLeave = useCallback((dir) => setDropTarget((d) => (d === dir ? null : d)), []);

  const onDrop = useCallback((dir, e) => {
    e.preventDefault();
    setDropTarget(null);
    const drags = dragRef.current;
    dragRef.current = [];
    if (drags.length && drags.every((p) => !isDescendant(p, dir) && parentDir(p) !== dir)) {
      explorer.moveEntries(drags, dir);
    }
  }, []);

  const onRename = useCallback((path, newName) => { explorer.renameEntry(path, newName); explorer.cancelRename(); }, []);
  const onRenameCancel = useCallback(() => explorer.cancelRename(), []);
  const onSearchOpen = useCallback((entry) => {
    if (entry.type === "directory") { explorer.setSearchQuery(""); explorer.selectOnly(entry.absolutePath); }
    else openFileRef.current(entry.absolutePath);
  }, []);

  if (!root) {
    return (
      <div className="fx-empty">
        <span>Open a folder to browse files.</span>
      </div>
    );
  }

  if (inSearch && searchMode === "symbols") {
    return <SymbolSearchList search={search} root={root} />;
  }

  if (inSearch) {
    if (search.results.length === 0) {
      return <div className="fx-tree"><div className="fx-empty fx-empty--sm">{search.loading ? "Searching…" : "No matches"}</div></div>;
    }
    return (
      <div className="fx-tree" role="tree">
        {search.results.map((entry) => (
          <div
            key={entry.absolutePath}
            className={"fx-row fx-search-row" + (entry.absolutePath === openPath ? " on" : "")}
            onClick={() => onSearchOpen(entry)}
          >
            <span className="fx-ic"><FileIcon type={entry.type} name={entry.name} expanded={false} /></span>
            <span className="fx-name">{entry.name}</span>
            <span className="fx-search-path">{entry.relativePath.includes("/") ? entry.relativePath.slice(0, entry.relativePath.lastIndexOf("/")) : ""}</span>
          </div>
        ))}
      </div>
    );
  }

  // Inject the inline new-file/folder draft row under its parent dir.
  let rows = visible;
  if (draft) {
    const draftNode = { kind: "draft", path: "__draft__", draftType: draft.type, parentDir: draft.parentDir };
    if (draft.parentDir === root) {
      rows = [{ ...draftNode, depth: 0 }, ...visible];
    } else {
      const i = visible.findIndex((n) => n.kind === "entry" && n.path === draft.parentDir);
      if (i !== -1) {
        rows = [...visible.slice(0, i + 1), { ...draftNode, depth: visible[i].depth + 1 }, ...visible.slice(i + 1)];
      }
    }
  }

  return (
    <div className="fx-tree" role="tree" ref={treeRef}>
      {rows.map((node) => {
        if (node.kind === "draft") return <DraftRow key={node.path} node={node} />;
        return (
          <FileRow
            key={node.path}
            node={node}
            selected={selection.ids.has(node.path)}
            anchor={selection.anchor === node.path}
            expanded={expanded.has(node.path)}
            renaming={renaming === node.path}
            dropTarget={dropTarget === node.path}
            onClick={onRowClick}
            onContext={onContext}
            onToggle={explorer.toggleExpand}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onRename={onRename}
            onRenameCancel={onRenameCancel}
          />
        );
      })}
    </div>
  );
}

function DraftRow({ node }) {
  return (
    <div className="fx-row fx-row--draft" style={{ paddingLeft: 8 + node.depth * 14 }}>
      <span className="tree-chev-spacer" />
      <span className="fx-ic"><FileIcon type={node.draftType} name="" expanded={false} /></span>
      <RenameInput
        currentName=""
        onSave={async (name) => { await explorer.createEntry(node.parentDir, name, node.draftType); explorer.cancelDraft(); }}
        onCancel={() => explorer.cancelDraft()}
      />
    </div>
  );
}
