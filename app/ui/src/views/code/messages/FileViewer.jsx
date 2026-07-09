import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useUi } from "../../../state/ui.jsx";
import { useOriginPane } from "../../../state/paneScope.js";
import { combo } from "../../../keymap/index.js";
import { useKeybinding } from "../../../keymap/useKeymap.js";
import { api } from "../../../api/client.js";
import { findAll, shortenHome } from "../../../lib/fileUtils.jsx";
import { fileKind } from "../../../lib/fileKind.js";
import { isMarkdownPath } from "../../../lib/markdownPreview.js";
import { repoRootForPath } from "../../../lib/symbolRoot.js";
import { useCodeLens } from "../../../hooks/useCodeLens.js";
import { EditView } from "./EditViewLazy.jsx";
import { MarkdownPreview } from "./MarkdownPreview.jsx";
import { PreviewToggle } from "./PreviewToggle.jsx";
import { getFileViewer } from "./fileViewers.jsx";
import { PanelShell } from "../panes/PanelShell.jsx";
import { SymbolRefsPanel } from "./SymbolRefsPanel.jsx";
import { useFileWatch } from "../../../state/fileWatchStore.js";

// Above this size the editor opens read-only with the lightweight extension
// set — editing affordances (history, autocomplete) cost too much on huge docs.
const HEAVY_TEXT_CHARS = 2 * 1024 * 1024;

export function FileViewer({ live }) {
  const ui = useUi();
  if (!ui.fileViewer) return <PanelShell type="file" />;
  return <FileViewerInner path={ui.fileViewer.path} live={live} />;
}

function FileViewerInner({ path, live }) {
  const ui = useUi();
  const [content, setContent] = useState(null);
  const [editContent, setEditContent] = useState("");
  const [binaryMeta, setBinaryMeta] = useState(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(null);
  const [showFind, setShowFind] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findIdx, setFindIdx] = useState(0);
  const [showOpenWith, setShowOpenWith] = useState(false);
  const [defaultApp, setDefaultApp] = useState(null);
  const [viewMode, setViewMode] = useState("source");
  const [frameGen, setFrameGen] = useState(0);
  const [reloadTick, setReloadTick] = useState(0);
  const findRef = useRef(null);

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

  useEffect(() => {
    if (!wantsText) return;
    let cancelled = false;
    setContent(null);
    setError(null);
    api.readFile(path)
      .then((data) => {
        if (cancelled) return;
        if (data.binary || data.large) {
          setBinaryMeta({ size: data.size, large: Boolean(data.large) });
          return;
        }
        setContent(data.content);
        setEditContent(data.content);
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
  const revealTarget = ui.fileViewer?.reveal;

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
      if (occ.length) ui.openFileViewer(occ[0].path, { line: occ[0].line, column: occ[0].column });
    }).catch(() => {});
  }, [root, path, ui.openFileViewer]);

  const symbolNav = useMemo(() => (root ? {
    onDefinition: goToDef,
    onContextMenu: ({ word }) => fetchRefs(word),
  } : null), [root, goToDef, fetchRefs]);

  const openOccurrence = useCallback(
    (occ) => ui.openFileViewer(occ.path, { line: occ.line, column: occ.column }),
    [ui.openFileViewer],
  );

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.writeFile(path, editContent);
      setContent(editContent);
    } catch (e) {
      setError(e.message);
    }
    setSaving(false);
  };

  const handleCancel = () => {
    setEditContent(content ?? "");
  };

  const findMatches = useMemo(
    () => (findQuery.length > 0 ? findAll(editContent, findQuery) : []),
    [editContent, findQuery],
  );
  const matchCount = findMatches.length;
  const safeIdx = matchCount > 0 ? ((findIdx % matchCount) + matchCount) % matchCount : 0;

  const toggleFind = () => {
    setShowFind((v) => !v);
    setShowOpenWith(false);
    if (!showFind) {
      setTimeout(() => findRef.current?.focus(), 50);
    }
  };

  // ⌘F while this pane's docked panel is the focused region → this find bar
  // outranks the chat's (priority 10 vs 0). Unlike the button's toggle, a repeat
  // ⌘F re-opens + selects the query (chat semantics). Non-text files have no
  // find bar, so their `when` fails and ⌘F falls through to the chat search.
  const paneId = useOriginPane() ?? ui.focusedLeafId;
  const paneFocused = paneId === ui.focusedLeafId;
  useKeybinding({
    match: combo("mod+f"),
    priority: 10,
    when: () => isText && ui.isPanelOpen("file") && paneFocused && ui.focusedRegion === "panel",
    run: (ctx, e) => {
      e.preventDefault();
      setShowOpenWith(false);
      setShowFind(true);
      requestAnimationFrame(() => { findRef.current?.focus(); findRef.current?.select(); });
    },
  }, [isText, ui.isPanelOpen, paneFocused, ui.focusedRegion]);

  const togglePreview = () => {
    setViewMode((m) => (m === "preview" ? "source" : "preview"));
    setShowFind(false);
    setShowOpenWith(false);
  };

  const shortPath = shortenHome(path);
  const dirty = isText && content !== null && editContent !== content;

  // Live-refresh on a disk change of THIS file (agent edit, git op, …). Refetch
  // unless the buffer is dirty or a save is in flight; close the panel on unlink.
  useFileWatch(path, {
    onChange: () => { if (!dirty && !saving) setReloadTick((t) => t + 1); },
    onRemove: () => ui.closeFileViewer(),
  });

  return (
    <PanelShell type="file">
      <div className="fv-row2">
        <span className="fv-path">{shortPath}</span>
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
            {isText && (dirty ? (
              <>
                <button className="fv-btn" onClick={handleCancel}>Cancel</button>
                <button className="fv-btn fv-btn--save" onClick={handleSave} disabled={saving}>Save</button>
              </>
            ) : (
              <>
                <button className={"fv-icon-btn" + (showFind ? " on" : "")} onClick={toggleFind} title="Find">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" />
                  </svg>
                </button>
                <button className={"fv-icon-btn" + (showOpenWith ? " on" : "")} onClick={() => { const opening = !showOpenWith; setShowOpenWith(opening); setShowFind(false); if (opening && !defaultApp) api.getDefaultApp(path).then((r) => setDefaultApp(r.app)); }} title="Open with" style={{ position: "relative" }}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 5V3.5A1.5 1.5 0 0 1 3.5 2H6l1.5 2H12.5A1.5 1.5 0 0 1 14 5.5V12.5A1.5 1.5 0 0 1 12.5 14H3.5A1.5 1.5 0 0 1 2 12.5V5Z" />
                  </svg>
                  {showOpenWith && (
                    <div className="fv-openwith" onClick={(e) => e.stopPropagation()}>
                      <div className="fv-ow-head">
                        <span>Open in</span>
                        <button className="fv-ow-close" onClick={() => setShowOpenWith(false)}>x</button>
                      </div>
                      <button className="fv-ow-item" onClick={() => { api.openFile(path); setShowOpenWith(false); }}>{defaultApp?.appName ?? "Default App"}</button>
                      <div className="fv-ow-sep" />
                      <button className="fv-ow-item" onClick={() => { api.revealFile(path); setShowOpenWith(false); }}>Show in Finder</button>
                    </div>
                  )}
                </button>
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
      </div>
      {showFind && (
        <div className="fv-find-bar">
          <input
            ref={findRef}
            className="fv-find-input"
            value={findQuery}
            onChange={(e) => { setFindQuery(e.target.value); setFindIdx(0); }}
            onKeyDown={(e) => { if (e.key === "Enter") setFindIdx((i) => i + (e.shiftKey ? -1 : 1)); if (e.key === "Escape") setShowFind(false); }}
            placeholder="Find..."
            spellCheck={false}
          />
          {findQuery && <span className="fv-find-count">{matchCount > 0 ? `${safeIdx + 1} of ${matchCount}` : "No results"}</span>}
          <button className="fv-find-nav" onClick={() => setFindIdx((i) => i - 1)} title="Previous">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="m4 10 4-4 4 4" /></svg>
          </button>
          <button className="fv-find-nav" onClick={() => setFindIdx((i) => i + 1)} title="Next">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="m4 6 4 4 4-4" /></svg>
          </button>
          <button className="fv-find-nav" onClick={() => { setShowFind(false); setFindQuery(""); }} title="Close">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="m4 4 8 8M12 4l-8 8" /></svg>
          </button>
        </div>
      )}
      <div className="fv-body">
        {viewer ? (
          <viewer.Body path={path} frameGen={frameGen} size={binaryMeta?.size} large={binaryMeta?.large} />
        ) : (
          <>
            {error && <div className="fv-error">{error}</div>}
            {content === null && !error && <div className="fv-loading">Loading...</div>}
            {content !== null && (
              showMarkdownPreview ? (
                <MarkdownPreview content={content} />
              ) : (
                <EditView
                  editContent={editContent}
                  setEditContent={setEditContent}
                  findQuery={findQuery}
                  currentMatch={safeIdx}
                  matches={findMatches}
                  filePath={path}
                  readOnly={content.length > HEAVY_TEXT_CHARS}
                  symbolNav={symbolNav}
                  codeLens={codeLens}
                  onCodeLensClick={onCodeLensClick}
                  onVisibleDefs={requestCounts}
                  revealLine={revealTarget?.line}
                  revealColumn={revealTarget?.column}
                  revealSeq={revealTarget?.seq}
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
    </PanelShell>
  );
}
