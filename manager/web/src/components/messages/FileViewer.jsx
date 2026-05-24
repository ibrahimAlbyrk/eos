import { useEffect, useState, useRef } from "react";
import { useUi } from "../../state/ui.jsx";
import { api } from "../../api/client.js";
import { findAll, shortenHome } from "../../lib/fileUtils.jsx";
import { CodeView } from "./CodeView.jsx";
import { EditView } from "./EditView.jsx";
import { MarkdownView } from "./MarkdownView.jsx";

export function FileViewer() {
  const ui = useUi();
  const open = !!ui.fileViewer;
  return (
    <div className={"file-viewer" + (open ? " fv-open" : "")}>
      {open && <FileViewerInner path={ui.fileViewer.path} editMode={ui.fileViewer.editMode} />}
    </div>
  );
}

function FileViewerInner({ path, editMode }) {
  const ui = useUi();
  const [content, setContent] = useState(null);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(null);
  const [showFind, setShowFind] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findIdx, setFindIdx] = useState(0);
  const [showOpenWith, setShowOpenWith] = useState(false);
  const [defaultApp, setDefaultApp] = useState(null);
  const textareaRef = useRef(null);
  const findRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    api.readFile(path)
      .then((data) => { if (!cancelled) { setContent(data.content); setEditContent(data.content); } })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [path]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.writeFile(path, editContent);
      setContent(editContent);
      ui.toggleFileEditMode();
    } catch (e) {
      setError(e.message);
    }
    setSaving(false);
  };

  const handleCancel = () => {
    setEditContent(content ?? "");
  };

  const activeContent = editMode ? editContent : (content ?? "");
  const findMatches = findQuery.length > 0 ? findAll(activeContent, findQuery) : [];
  const matchCount = findMatches.length;
  const safeIdx = matchCount > 0 ? ((findIdx % matchCount) + matchCount) % matchCount : 0;

  const toggleFind = () => {
    setShowFind((v) => !v);
    setShowOpenWith(false);
    if (!showFind) {
      if (!editMode) ui.toggleFileEditMode();
      setTimeout(() => findRef.current?.focus(), 50);
    }
  };

  const shortPath = shortenHome(path);
  const isMd = path.endsWith(".md");
  const dirty = editMode && content !== null && editContent !== content;

  const codeIcon = (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="m5 4.5-3.5 3.5 3.5 3.5" /><path d="m11 4.5 3.5 3.5-3.5 3.5" /><path d="m9.5 3-3 10" />
    </svg>
  );
  const eyeIcon = (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.5 8s2.5-4.5 6.5-4.5 6.5 4.5 6.5 4.5-2.5 4.5-6.5 4.5S1.5 8 1.5 8Z" /><circle cx="8" cy="8" r="2" />
    </svg>
  );

  return (
    <>
      <div className="fv-row1">
        <span className="fv-title">File</span>
        <button className="fv-icon-btn fv-close" onClick={ui.closeFileViewer} title="Close">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="m4 4 8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
      <div className="fv-row2">
        <span className="fv-path">{shortPath}</span>
        <div className="fv-actions">
          {dirty ? (
            <>
              <button className="fv-btn" onClick={handleCancel}>Cancel</button>
              <button className="fv-btn fv-btn--save" onClick={handleSave} disabled={saving}>Save</button>
            </>
          ) : (
            <>
              <button className="fv-icon-btn" onClick={ui.toggleFileEditMode} title={editMode ? "Preview" : "Edit"}>
                {editMode ? eyeIcon : codeIcon}
              </button>
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
          )}
        </div>
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
        {error && <div className="fv-error">{error}</div>}
        {content === null && !error && <div className="fv-loading">Loading...</div>}
        {content !== null && !editMode && (
          isMd ? <MarkdownView content={content} /> : <CodeView content={content} findQuery={findQuery} currentMatch={safeIdx} matches={findMatches} activeMatchKey={`${safeIdx}-${findQuery}`} filePath={path} />
        )}
        {content !== null && editMode && (
          <EditView
            textareaRef={textareaRef}
            editContent={editContent}
            setEditContent={setEditContent}
            findQuery={findQuery}
            currentMatch={safeIdx}
            matches={findMatches}
            filePath={path}
          />
        )}
      </div>
    </>
  );
}
