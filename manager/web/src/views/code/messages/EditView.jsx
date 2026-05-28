import { useEffect, useMemo, useState, useRef } from "react";
import hljs from "highlight.js/lib/common";
import { extToLang, highlightMatches } from "../../../lib/fileUtils.jsx";

export function EditView({ textareaRef, editContent, setEditContent, findQuery, currentMatch, matches, filePath }) {
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
