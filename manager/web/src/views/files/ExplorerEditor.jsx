import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client.js";
import { explorer, useExternalChange, useOpenPath } from "../../state/explorerStore.js";
import { findAll, shortenHome } from "../../lib/fileUtils.jsx";
import { fileKind } from "../../lib/fileKind.js";
import { EditView } from "../code/messages/EditView.jsx";
import { getFileViewer } from "../code/messages/fileViewers.jsx";

// Above this size the editor opens read-only with the lightweight extension set.
const HEAVY_TEXT_CHARS = 2 * 1024 * 1024;
// MRU of unsaved buffers, keyed by path — survives switching files (and the
// per-path remount via key=) so edits aren't lost when you click away and back.
const BUFFER_CAP = 8;
const buffers = new Map();
function rememberBuffer(path, text) {
  buffers.delete(path);
  buffers.set(path, text);
  while (buffers.size > BUFFER_CAP) buffers.delete(buffers.keys().next().value);
}

export function ExplorerEditor() {
  const path = useOpenPath();
  if (!path) {
    return (
      <div className="fx-editor">
        <div className="fx-editor-empty">Select a file to view or edit</div>
      </div>
    );
  }
  return <EditorInner key={path} path={path} />;
}

function EditorInner({ path }) {
  const externalChange = useExternalChange();
  const [content, setContent] = useState(null);
  const [editContent, setEditContent] = useState("");
  const [binaryMeta, setBinaryMeta] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [showFind, setShowFind] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findIdx, setFindIdx] = useState(0);
  const [copied, setCopied] = useState(false);
  const findRef = useRef(null);

  const baseKind = fileKind(path);
  const wantsText = baseKind === "text";
  const kind = wantsText ? (binaryMeta ? "binary" : "text") : baseKind;
  const viewer = getFileViewer(kind);
  const isText = kind === "text";

  useEffect(() => {
    if (!wantsText) return;
    let cancelled = false;
    setContent(null);
    setError(null);
    setBinaryMeta(null);
    api.readFile(path)
      .then((data) => {
        if (cancelled) return;
        if (data.binary || data.large) { setBinaryMeta({ size: data.size, large: Boolean(data.large) }); return; }
        setContent(data.content);
        setEditContent(buffers.get(path) ?? data.content);
      })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [path, wantsText, reloadTick]);

  const dirty = isText && content !== null && editContent !== content;

  // Mirror dirty into the store (tree dot) + keep the MRU buffer current.
  useEffect(() => {
    if (!isText || content === null) return;
    explorer.markDirty(path, dirty);
    rememberBuffer(path, editContent);
  }, [path, isText, content, editContent, dirty]);

  // React to a disk change of THIS file (agent edit, git op, …).
  useEffect(() => {
    if (!externalChange || externalChange.path !== path) return;
    explorer.consumeExternalChange();
    if (externalChange.kind === "unlink") { explorer.closeFile(); return; }
    if (!dirty) { buffers.delete(path); setReloadTick((t) => t + 1); }
  }, [externalChange, path, dirty]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.writeFile(path, editContent, { root: explorer.getState().root });
      if (res.ok) { setContent(editContent); buffers.delete(path); explorer.markDirty(path, false); }
      else setError(res.body?.error || "save failed");
    } catch (e) { setError(e.message); }
    setSaving(false);
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  // Cmd+S — single listener; reads the latest save via ref.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) { e.preventDefault(); saveRef.current(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const findMatches = useMemo(() => (findQuery ? findAll(editContent, findQuery) : []), [editContent, findQuery]);
  const matchCount = findMatches.length;
  const safeIdx = matchCount > 0 ? ((findIdx % matchCount) + matchCount) % matchCount : 0;

  const toggleFind = () => {
    setShowFind((v) => !v);
    if (!showFind) setTimeout(() => findRef.current?.focus(), 50);
  };

  return (
    <div className="fx-editor">
      <div className="fv-row2 fx-ed-head">
        <span className="fv-path" title={path}>
          {shortenHome(path)}
          {dirty && <span className="fx-ed-dirty" title="Unsaved changes" />}
        </span>
        {isText && (
          <div className="fv-actions">
            {dirty ? (
              <>
                <button className="fv-btn" onClick={() => { setEditContent(content ?? ""); buffers.delete(path); }}>Revert</button>
                <button className="fv-btn fv-btn--save" onClick={save} disabled={saving}>Save</button>
              </>
            ) : (
              <>
                <button className={"fv-icon-btn" + (showFind ? " on" : "")} onClick={toggleFind} title="Find">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
                </button>
                <button className="fv-icon-btn" onClick={() => api.revealFile(path)} title="Reveal in Finder">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 5V3.5A1.5 1.5 0 0 1 3.5 2H6l1.5 2H12.5A1.5 1.5 0 0 1 14 5.5V12.5A1.5 1.5 0 0 1 12.5 14H3.5A1.5 1.5 0 0 1 2 12.5V5Z" /></svg>
                </button>
                <button className="fv-icon-btn" onClick={() => { navigator.clipboard?.writeText(content ?? ""); setCopied(true); setTimeout(() => setCopied(false), 2000); }} title="Copy">
                  {copied ? (
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m3 8.5 3 3 7-7" /></svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="5" y="5" width="9" height="9" rx="1.5" /><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" /></svg>
                  )}
                </button>
              </>
            )}
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
          <button className="fv-find-nav" onClick={() => setFindIdx((i) => i - 1)} title="Previous"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="m4 10 4-4 4 4" /></svg></button>
          <button className="fv-find-nav" onClick={() => setFindIdx((i) => i + 1)} title="Next"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="m4 6 4 4 4-4" /></svg></button>
          <button className="fv-find-nav" onClick={() => { setShowFind(false); setFindQuery(""); }} title="Close"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="m4 4 8 8M12 4l-8 8" /></svg></button>
        </div>
      )}

      <div className="fv-body">
        {viewer ? (
          <viewer.Body path={path} frameGen={0} size={binaryMeta?.size} large={binaryMeta?.large} />
        ) : (
          <>
            {error && <div className="fv-error">{error}</div>}
            {content === null && !error && <div className="fv-loading">Loading…</div>}
            {content !== null && (
              <EditView
                editContent={editContent}
                setEditContent={setEditContent}
                findQuery={findQuery}
                currentMatch={safeIdx}
                matches={findMatches}
                filePath={path}
                readOnly={content.length > HEAVY_TEXT_CHARS}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
