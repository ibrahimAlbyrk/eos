import { useEffect, useMemo, useState, useRef } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { findAll, shortenHome } from "../../../lib/fileUtils.jsx";
import { fileKind } from "../../../lib/fileKind.js";
import { EditView } from "./EditView.jsx";
import { getFileViewer } from "./fileViewers.jsx";

export function FileViewer() {
  const ui = useUi();
  const open = !!ui.fileViewer;
  return (
    <div className={"file-viewer" + (ui.topPanelType === "file" ? " fv-open" : "")}>
      {open && <FileViewerInner path={ui.fileViewer.path} />}
    </div>
  );
}

function FileViewerInner({ path }) {
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
  const [htmlMode, setHtmlMode] = useState("preview");
  const [frameGen, setFrameGen] = useState(0);
  const findRef = useRef(null);

  const baseKind = fileKind(path);
  const wantsText = baseKind === "text" || (baseKind === "html" && htmlMode === "source");
  const kind = wantsText ? (binaryMeta ? "binary" : "text") : baseKind;
  const viewer = getFileViewer(kind);
  const isText = kind === "text";

  useEffect(() => {
    setHtmlMode("preview");
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
        if (data.binary) {
          setBinaryMeta({ size: data.size });
          return;
        }
        setContent(data.content);
        setEditContent(data.content);
      })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [path, wantsText]);

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

  const shortPath = shortenHome(path);
  const dirty = isText && content !== null && editContent !== content;

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
        {(isText || baseKind === "html") && (
          <div className="fv-actions">
            {baseKind === "html" && (
              <>
                {htmlMode === "preview" && (
                  <button className="fv-icon-btn" onClick={() => setFrameGen((g) => g + 1)} title="Reload">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" /><path d="M13.5 1.5v3h-3" />
                    </svg>
                  </button>
                )}
                <button className="fv-btn" onClick={() => setHtmlMode((m) => (m === "preview" ? "source" : "preview"))}>
                  {htmlMode === "preview" ? "Source" : "Preview"}
                </button>
              </>
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
          <viewer.Body path={path} frameGen={frameGen} size={binaryMeta?.size} />
        ) : (
          <>
            {error && <div className="fv-error">{error}</div>}
            {content === null && !error && <div className="fv-loading">Loading...</div>}
            {content !== null && (
              <EditView
                editContent={editContent}
                setEditContent={setEditContent}
                findQuery={findQuery}
                currentMatch={safeIdx}
                matches={findMatches}
                filePath={path}
              />
            )}
          </>
        )}
      </div>
    </>
  );
}
