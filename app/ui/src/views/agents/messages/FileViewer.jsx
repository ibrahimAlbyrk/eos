import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useUi } from "../../../state/ui.jsx";
import { useSidePanelVisible } from "../../../state/paneScope.js";
import { combo } from "../../../keymap/index.js";
import { useKeybinding } from "../../../keymap/useKeymap.js";
import { api } from "../../../api/client.js";
import { hasLocalScreen } from "../../../lib/host.js";
import { findAll, shortenHome } from "../../../lib/fileUtils.jsx";
import { fileKind } from "../../../lib/fileKind.js";
import { isMarkdownPath } from "../../../lib/markdownPreview.js";
import { repoRootForPath } from "../../../lib/symbolRoot.js";
import { useCodeLens } from "../../../hooks/useCodeLens.js";
import { useFind } from "../../../hooks/useFind.js";
import { useDomFind } from "../../../hooks/usePageFind.js";
import { EditView } from "./EditViewLazy.jsx";
import { FindBar } from "./FindBar.jsx";
import { MarkdownPreview } from "./MarkdownPreview.jsx";
import { PreviewToggle } from "./PreviewToggle.jsx";
import { getFileViewer } from "./fileViewers.jsx";
import { SymbolRefsPanel } from "./SymbolRefsPanel.jsx";
import { useFileWatch } from "../../../state/fileWatchStore.js";
import { filePathOf } from "../../../lib/panelTabs.js";

// Above this size the editor opens read-only with the lightweight extension
// set — editing affordances (history, autocomplete) cost too much on huge docs.
const HEAVY_TEXT_CHARS = 2 * 1024 * 1024;

// A `file:<path>` side-panel tab: a pinned file, one per tab.
export function FileViewer({ live, tabId }) {
  const ui = useUi();
  const visible = useSidePanelVisible();
  const path = filePathOf(tabId);
  if (!path) return null;
  return (
    <FileView
      path={path}
      live={live}
      reveal={ui.panelData?.[tabId]?.reveal}
      findActive={visible && ui.focusedRegion === "panel"}
      onRemove={() => ui.closeTab(tabId)}
    />
  );
}

// One file, shown by a pinned tab or the panel's dock. `findActive` says when
// ⌘F and ⌘S belong to this viewer (`findPriority` breaks a tie with another viewer);
// `onRemove` runs when the file is deleted on disk; `lead`/`trail` are the
// host's own controls around the path row.
export function FileView({ path, live, reveal, findActive, findPriority = 10, onRemove, lead, trail }) {
  const ui = useUi();
  const [content, setContent] = useState(null);
  const [editContent, setEditContent] = useState("");
  const [binaryMeta, setBinaryMeta] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(null);
  const [showOpenWith, setShowOpenWith] = useState(false);
  const [defaultApp, setDefaultApp] = useState(null);
  const [viewMode, setViewMode] = useState("source");
  const [frameGen, setFrameGen] = useState(0);
  const [reloadTick, setReloadTick] = useState(0);
  const contentRef = useRef(content);
  contentRef.current = content;
  const editContentRef = useRef(editContent);
  editContentRef.current = editContent;
  const loadedPathRef = useRef(null);
  const bodyRef = useRef(null);
  const previewRef = useRef(null);

  const baseKind = fileKind(path);
  const isMarkdown = baseKind === "text" && isMarkdownPath(path);
  const previewable = isMarkdown || baseKind === "html";
  const inPreview = previewable && viewMode === "preview";
  // HTML preview is a standalone iframe body (no text fetch); markdown always
  // loads as text and the body picks EditView vs the rendered preview.
  const wantsText = baseKind === "text" || (baseKind === "html" && !inPreview);
  const kind = wantsText ? (binaryMeta ? "binary" : "text") : baseKind;
  const viewer = getFileViewer(kind);
  const isText = kind === "text";
  const showMarkdownPreview = isMarkdown && inPreview;

  useEffect(() => {
    setViewMode(fileKind(path) === "html" || isMarkdownPath(path) ? "preview" : "source");
    setFrameGen(0);
    setBinaryMeta(null);
  }, [path]);

  // The first load of a path shows Loading…; a later disk refresh (our own save
  // included) keeps the editor mounted — scroll, cursor and undo history survive
  // — and swaps in only a real change, never over unsaved edits.
  useEffect(() => {
    if (!wantsText) return;
    let cancelled = false;
    const refresh = loadedPathRef.current === path;
    if (!refresh) {
      setContent(null);
      setError(null);
    }
    api.readFile(path)
      .then((data) => {
        if (cancelled) return;
        if (data.binary || data.large) {
          setBinaryMeta({ size: data.size, large: Boolean(data.large) });
          return;
        }
        loadedPathRef.current = path;
        if (refresh && data.content === contentRef.current) return;
        if (!refresh || editContentRef.current === contentRef.current) setEditContent(data.content);
        setContent(data.content);
      })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [path, wantsText, reloadTick]);

  // ---- symbol intelligence (CodeLens · references · go-to-def) --------------
  // Root = the worker worktree/cwd that contains this file; null → no symbol UI.
  const root = useMemo(() => repoRootForPath(path, live?.workers), [path, live?.workers]);
  const rootRef = useRef(root);
  rootRef.current = root;
  const [refs, setRefs] = useState(null); // { name, occurrences, loading } | null
  const refsRef = useRef(refs);
  refsRef.current = refs;

  // Definitions + lazy reference counts come from the shared hook (also used by
  // the Files-tab editor); the references drawer + go-to-def stay local here.
  const { codeLens, requestCounts } = useCodeLens({ root, path, enabled: isText && content !== null });

  useEffect(() => { setRefs(null); }, [path]); // drop the drawer when the file changes

  // Open the references drawer for a symbol (chip click / right-click find-refs).
  const fetchRefs = useCallback((name) => {
    if (!root) return;
    setRefs({ name, occurrences: [], loading: true });
    api.symbolsLookup(root, name, "references", path).then((res) => {
      if (rootRef.current !== root) return;
      if (!res) { setRefs((prev) => (prev?.name === name ? null : prev)); return; }
      const occ = res.occurrences ?? [];
      setRefs((prev) => (prev?.name === name ? { name, occurrences: occ, loading: false } : prev));
    }).catch(() => setRefs((prev) => (prev?.name === name ? null : prev)));
  }, [root, path]);

  const onCodeLensClick = useCallback((def) => {
    if (refsRef.current?.name === def.name) { setRefs(null); return; } // toggle off
    fetchRefs(def.name);
  }, [fetchRefs]);

  // Cmd/Ctrl-click → go to definition: navigate to the top-ranked hit.
  const goToDef = useCallback((word) => {
    if (!root) return;
    api.symbolsLookup(root, word, "definitions", path).then((res) => {
      const occ = res?.occurrences ?? [];
      if (occ.length) ui.openFile(occ[0].path, { line: occ[0].line, column: occ[0].column });
    }).catch(() => {});
  }, [root, path, ui.openFile]);

  const symbolNav = useMemo(() => (root ? {
    onDefinition: goToDef,
    onContextMenu: ({ word }) => fetchRefs(word),
  } : null), [root, goToDef, fetchRefs]);

  const openOccurrence = useCallback(
    (occ) => ui.openFile(occ.path, { line: occ.line, column: occ.column }),
    [ui.openFile],
  );

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.writeFile(path, editContent);
      setContent(editContent);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(e.message);
    }
    setSaving(false);
  };

  const handleCancel = () => {
    setEditContent(content ?? "");
  };

  // ⌘F while this viewer is the focused side panel's find target
  // → this find bar outranks the chat's (priority 10 vs 0). Unlike the button's
  // toggle, a repeat ⌘F re-opens + selects the query (chat semantics). Non-text
  // files have no find bar, so their `when` fails and ⌘F falls through to chat.
  const find = useFind({ priority: findPriority, when: () => isText && findActive }, [isText, findActive, findPriority]);
  useEffect(() => { if (find.open) setShowOpenWith(false); }, [find.open]);

  // Source matches are offsets in the text; the rendered markdown preview is
  // searched as DOM, like the chat.
  const findMatches = useMemo(
    () => (find.open && find.query && !showMarkdownPreview ? findAll(editContent, find.query) : []),
    [find.open, find.query, showMarkdownPreview, editContent],
  );
  const previewMatchCount = useDomFind({
    contentRef: previewRef,
    wrapRef: bodyRef,
    deps: [content],
    enabled: showMarkdownPreview && findActive,
    open: find.open,
    query: find.query,
    idx: find.idx,
    setIdx: find.setIdx,
    seed: find.seed,
    name: "fv-find",
  });
  const matchCount = showMarkdownPreview ? previewMatchCount : findMatches.length;
  const safeIdx = matchCount > 0 ? ((find.idx % matchCount) + matchCount) % matchCount : 0;
  const findBar = {
    ...find,
    matchCount,
    idx: safeIdx,
    next: () => find.move(1, matchCount),
    prev: () => find.move(-1, matchCount),
  };
  const toggleFind = () => (find.open ? find.close() : find.show());

  const togglePreview = () => {
    setViewMode((m) => (m === "preview" ? "source" : "preview"));
    setShowOpenWith(false);
  };

  const shortPath = shortenHome(path);
  const slashIdx = shortPath.lastIndexOf("/");
  const pathDir = slashIdx < 0 ? "" : shortPath.slice(0, slashIdx + 1);
  const pathBase = shortPath.slice(slashIdx + 1);
  const dirty = isText && content !== null && editContent !== content;

  // Live-refresh on a disk change of THIS file (agent edit, git op, …). Refetch
  // unless the buffer is dirty or a save is in flight; let the host drop it on unlink.
  useFileWatch(path, {
    onChange: () => { if (!dirty && !saving) setReloadTick((t) => t + 1); },
    onRemove,
  });

  const saveRef = useRef(null);
  saveRef.current = dirty && !saving ? handleSave : null;
  useKeybinding({
    match: combo("mod+s"),
    priority: findPriority,
    when: () => isText && findActive,
    run: (ctx, e) => {
      e.preventDefault();
      saveRef.current?.();
    },
  }, [isText, findActive, findPriority]);

  // Save/Cancel must not steal focus from the editor, or ⌘Z after a click
  // would no longer reach the file's undo history.
  const keepFocus = (e) => e.preventDefault();

  return (
    <div className="panel-shell panel-shell--file">
      <div className="fv-row2">
        {lead}
        <span className="fv-path" title={shortPath}>
          {pathDir && <span className="fv-path-dir">{pathDir}</span>}
          {pathBase}
          {dirty && <span className="fv-path-dirty"> ●</span>}
          {saved && !dirty && <span className="fv-path-saved">Saved</span>}
        </span>
        {(isText || baseKind === "html") && (
          <div className="fv-actions">
            {previewable && <PreviewToggle mode={viewMode} onToggle={togglePreview} />}
            {baseKind === "html" && inPreview && (
              <button className="fv-icon-btn" onClick={() => setFrameGen((g) => g + 1)} title="Reload">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" /><path d="M13.5 1.5v3h-3" />
                </svg>
              </button>
            )}
            {isText && (
              <button className={"fv-icon-btn" + (find.open ? " on" : "")} onClick={toggleFind} title="Find">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" />
                </svg>
              </button>
            )}
            {isText && (dirty ? (
              <>
                <button className="fv-btn" onMouseDown={keepFocus} onClick={handleCancel}>Cancel</button>
                <button className="fv-btn fv-btn--save" onMouseDown={keepFocus} onClick={handleSave} disabled={saving} title="Save (⌘S)">
                  Save<span className="fv-btn-kbd">⌘S</span>
                </button>
              </>
            ) : (
              <>
                {/* The menu sits beside the button, not inside it: the button's
                    hover glass is a backdrop-filter, which would blank the menu's. */}
                <span style={{ position: "relative", display: "inline-flex" }}>
                  <button className={"fv-icon-btn" + (showOpenWith ? " on" : "")} onClick={() => { const opening = !showOpenWith; setShowOpenWith(opening); find.close(); if (opening && !defaultApp) api.getDefaultApp(path).then((r) => setDefaultApp(r.app)); }} title="Open with">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2 5V3.5A1.5 1.5 0 0 1 3.5 2H6l1.5 2H12.5A1.5 1.5 0 0 1 14 5.5V12.5A1.5 1.5 0 0 1 12.5 14H3.5A1.5 1.5 0 0 1 2 12.5V5Z" />
                    </svg>
                  </button>
                  {showOpenWith && (
                    <div className="fv-openwith">
                      <div className="fv-ow-head">
                        <span>Open in</span>
                        <button className="fv-ow-close" onClick={() => setShowOpenWith(false)}>x</button>
                      </div>
                      <button className="fv-ow-item" onClick={() => { api.openFile(path); setShowOpenWith(false); }}>{hasLocalScreen() ? (defaultApp?.appName ?? "Default App") : "This Mac (copy)"}</button>
                      {hasLocalScreen() && <div className="fv-ow-sep" />}
                      {hasLocalScreen() && <button className="fv-ow-item" onClick={() => { api.revealFile(path); setShowOpenWith(false); }}>Show in Finder</button>}
                    </div>
                  )}
                </span>
                <button className="fv-icon-btn" onClick={() => { navigator.clipboard.writeText(content ?? ""); setCopied(true); setTimeout(() => setCopied(false), 3000); }} title="Copy">
                  {copied ? (
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m3 8.5 3 3 7-7" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <rect x="5" y="5" width="9" height="9" rx="1.5" />
                      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
                    </svg>
                  )}
                </button>
              </>
            ))}
          </div>
        )}
        {trail}
      </div>
      <div className="fv-body" ref={bodyRef}>
        {isText && find.open && <FindBar find={findBar} />}
        {viewer ? (
          <viewer.Body path={path} frameGen={frameGen} size={binaryMeta?.size} large={binaryMeta?.large} />
        ) : (
          <>
            {error && <div className="fv-error">{error}</div>}
            {content === null && !error && <div className="fv-loading">Loading...</div>}
            {content !== null && (
              showMarkdownPreview ? (
                <div ref={previewRef}>
                  <MarkdownPreview content={content} path={path} onOpenPath={ui.openFile} />
                </div>
              ) : (
                <EditView
                  editContent={editContent}
                  setEditContent={setEditContent}
                  findQuery={find.open ? find.query : ""}
                  findSeed={find.seed}
                  currentMatch={safeIdx}
                  matches={findMatches}
                  onPlaceMatch={find.setIdx}
                  filePath={path}
                  readOnly={content.length > HEAVY_TEXT_CHARS}
                  symbolNav={symbolNav}
                  codeLens={codeLens}
                  onCodeLensClick={onCodeLensClick}
                  onVisibleDefs={requestCounts}
                  revealLine={reveal?.line}
                  revealColumn={reveal?.column}
                  revealSeq={reveal?.seq}
                />
              )
            )}
          </>
        )}
      </div>
      {refs && root && (
        <SymbolRefsPanel
          refs={refs}
          root={root}
          currentPath={path}
          onOpen={openOccurrence}
          onClose={() => setRefs(null)}
        />
      )}
    </div>
  );
}
