import { useEffect, useLayoutEffect, useMemo, useState, useRef } from "react";
import { useUi } from "../../state/ui.jsx";
import { api } from "../../api/client.js";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github-dark-dimmed.min.css";

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
                      <button className="fv-ow-close" onClick={() => setShowOpenWith(false)}>×</button>
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
            placeholder="Find…"
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
        {content === null && !error && <div className="fv-loading">Loading…</div>}
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

function EditView({ textareaRef, editContent, setEditContent, findQuery, currentMatch, matches, filePath }) {
  const [cursorLine, setCursorLine] = useState(-1);
  const overlayRef = useRef(null);

  const updateCursor = (el) => {
    const pos = el.selectionDirection === "backward" ? el.selectionStart : el.selectionEnd;
    setCursorLine(el.value.substring(0, pos).split("\n").length - 1);
  };

  const syncScroll = (e) => {
    if (overlayRef.current) {
      overlayRef.current.scrollTop = e.target.scrollTop;
      overlayRef.current.scrollLeft = e.target.scrollLeft;
    }
  };

  const lang = extToLang(filePath);
  const highlighted = useMemo(() => {
    if (!editContent || !lang) return null;
    try {
      return hljs.highlight(editContent, { language: lang }).value;
    } catch { return null; }
  }, [editContent, lang]);

  const highlightedLines = useMemo(() => {
    if (!highlighted) return null;
    return highlighted.split("\n");
  }, [highlighted]);

  const lines = (editContent || "").split("\n");
  const currentMatchLine = matches.length > 0 ? editContent.substring(0, matches[currentMatch]).split("\n").length - 1 : -1;

  useEffect(() => {
    if (matches.length === 0 || !textareaRef.current) return;
    const lineTop = currentMatchLine * 20;
    const container = textareaRef.current;
    const visible = lineTop >= container.scrollTop && lineTop <= container.scrollTop + container.clientHeight - 40;
    if (!visible) container.scrollTop = Math.max(0, lineTop - container.clientHeight / 2);
  }, [currentMatch, matches.length]);

  return (
    <div className="fv-editor">
      <div className="fv-edit-gutter">
        {lines.map((_, i) => (
          <div className={"fv-gutter-ln" + (i === cursorLine ? " active" : "")} key={i}>{i + 1}</div>
        ))}
      </div>
      <div className="fv-edit-content">
        <div className={"fv-highlight-overlay" + (highlightedLines ? " fv-hl-active" : "")} ref={overlayRef} aria-hidden>
          {lines.map((line, i) => {
            const isCursor = i === cursorLine;
            const isMatchLine = i === currentMatchLine;
            const cls = "fv-ov-line" + (isCursor ? " cursor" : "") + (isMatchLine ? " match-line" : "");
            if (highlightedLines) {
              return <div key={i} className={cls} dangerouslySetInnerHTML={{ __html: highlightedLines[i] + "&nbsp;" }} />;
            }
            return <div key={i} className={cls}>{line}&nbsp;</div>;
          })}
        </div>
        {findQuery && (
          <div className="fv-find-overlay" aria-hidden>
            {lines.map((line, i) => (
              <div key={i}>{highlightMatches(line, findQuery, i, currentMatch, matches, editContent)}&nbsp;</div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className={"fv-textarea" + (highlightedLines || findQuery ? " fv-textarea--hl" : "")}
          value={editContent}
          onChange={(e) => { setEditContent(e.target.value); updateCursor(e.target); }}
          onKeyUp={(e) => updateCursor(e.target)}
          onMouseDown={(e) => setTimeout(() => updateCursor(e.target), 0)}
          onMouseMove={(e) => { if (e.buttons === 1) updateCursor(e.target); }}
          onMouseUp={(e) => updateCursor(e.target)}
          onFocus={(e) => updateCursor(e.target)}
          onScroll={syncScroll}
          spellCheck={false}
        />
      </div>
    </div>
  );
}

function CodeView({ content, findQuery, currentMatch, matches, activeMatchKey, filePath }) {
  const bodyRef = useRef(null);
  const lines = content.split("\n");
  const lang = extToLang(filePath);

  const highlightedLines = useMemo(() => {
    if (!lang) return null;
    try { return hljs.highlight(content, { language: lang }).value.split("\n"); }
    catch { return null; }
  }, [content, lang]);

  useEffect(() => {
    if (!bodyRef.current || matches.length === 0) return;
    const mark = bodyRef.current.querySelector(".fv-match.current");
    if (mark) mark.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeMatchKey, matches.length]);

  return (
    <div className="fv-code" ref={bodyRef}>
      {lines.map((line, i) => (
        <div className="fv-code-line" key={i}>
          <span className="fv-ln">{i + 1}</span>
          {findQuery ? (
            <span className="fv-lc">{highlightMatches(line, findQuery, i, currentMatch, matches, content)}</span>
          ) : highlightedLines ? (
            <span className="fv-lc hljs" dangerouslySetInnerHTML={{ __html: highlightedLines[i] }} />
          ) : (
            <span className="fv-lc">{line}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function highlightMatches(line, query, lineIdx, currentMatch, matches, fullContent) {
  if (!query) return line;
  const lc = line.toLowerCase();
  const qLc = query.toLowerCase();
  const parts = [];
  let last = 0;
  let lineOffset = fullContent.split("\n").slice(0, lineIdx).join("\n").length + (lineIdx > 0 ? 1 : 0);
  let idx = lc.indexOf(qLc);
  while (idx !== -1) {
    if (idx > last) parts.push(line.slice(last, idx));
    const globalPos = lineOffset + idx;
    const matchIdx = matches.indexOf(globalPos);
    const isCurrent = matchIdx === currentMatch;
    parts.push(<mark key={idx} className={"fv-match" + (isCurrent ? " current" : "")}>{line.slice(idx, idx + query.length)}</mark>);
    last = idx + query.length;
    idx = lc.indexOf(qLc, last);
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts.length > 0 ? parts : line;
}

function findAll(text, query) {
  if (!query) return [];
  const lc = text.toLowerCase();
  const qLc = query.toLowerCase();
  const results = [];
  let idx = lc.indexOf(qLc);
  while (idx !== -1) {
    results.push(idx);
    idx = lc.indexOf(qLc, idx + 1);
  }
  return results;
}

function MarkdownView({ content }) {
  const html = renderMarkdown(content);
  return <div className="fv-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

const EXT_LANG = {
  js: "javascript", jsx: "javascript", mjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript",
  json: "json", json5: "json",
  md: "markdown", mdx: "markdown",
  css: "css", scss: "scss", less: "less",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", jsx: "xml",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  cs: "csharp",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
  swift: "swift",
  sh: "bash", bash: "bash", zsh: "bash",
  sql: "sql",
  yaml: "yaml", yml: "yaml",
  toml: "ini",
  ini: "ini",
  lua: "lua",
  r: "r",
  php: "php",
  pl: "perl",
  diff: "diff", patch: "diff",
  makefile: "makefile",
  dockerfile: "bash",
  graphql: "graphql", gql: "graphql",
};

function extToLang(filePath) {
  if (!filePath) return null;
  const name = filePath.split("/").pop().toLowerCase();
  if (name === "makefile" || name === "dockerfile") return EXT_LANG[name.toLowerCase()] ?? null;
  const ext = name.split(".").pop();
  return EXT_LANG[ext] ?? null;
}

function shortenHome(p) {
  if (!p) return "";
  const home = "/Users/";
  if (p.startsWith(home)) {
    const rest = p.slice(home.length);
    const slash = rest.indexOf("/");
    return slash === -1 ? "~" : "~" + rest.slice(slash);
  }
  return p;
}

function renderMarkdown(src) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = src.split("\n");
  let html = "";
  let inCode = false;
  let inList = false;

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inList) { html += "</ul>"; inList = false; }
      if (inCode) { html += "</pre>"; inCode = false; }
      else { html += "<pre>"; inCode = true; }
      continue;
    }
    if (inCode) { html += esc(line) + "\n"; continue; }

    const trimmed = line.trim();
    if (!trimmed) {
      if (inList) { html += "</ul>"; inList = false; }
      html += "<br/>";
      continue;
    }

    const hMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (hMatch) {
      if (inList) { html += "</ul>"; inList = false; }
      const level = hMatch[1].length;
      html += `<h${level}>${inlineFormat(esc(hMatch[2]))}</h${level}>`;
      continue;
    }

    const liMatch = trimmed.match(/^[-*]\s+(.*)$/);
    if (liMatch) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inlineFormat(esc(liMatch[1]))}</li>`;
      continue;
    }

    if (inList) { html += "</ul>"; inList = false; }
    html += `<p>${inlineFormat(esc(trimmed))}</p>`;
  }
  if (inCode) html += "</pre>";
  if (inList) html += "</ul>";
  return html;
}

function inlineFormat(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}
