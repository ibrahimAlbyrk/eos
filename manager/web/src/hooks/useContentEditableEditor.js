import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";

export function getCursorOffset(el) {
  const sel = window.getSelection();
  if (!sel.rangeCount || !el.contains(sel.anchorNode)) return 0;
  const range = sel.getRangeAt(0).cloneRange();
  range.selectNodeContents(el);
  range.setEnd(sel.anchorNode, sel.anchorOffset);
  return range.toString().length;
}

function setCursorOffset(el, offset) {
  const sel = window.getSelection();
  const range = document.createRange();
  let pos = 0;
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.textContent.length;
      if (pos + len >= offset) {
        range.setStart(node, offset - pos);
        range.collapse(true);
        return true;
      }
      pos += len;
      return false;
    }
    for (const child of node.childNodes) {
      if (walk(child)) return true;
    }
    return false;
  }
  if (walk(el)) {
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function colorize(text, cmdMap, filePaths) {
  const regions = [];

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "/") continue;
    let end = i + 1;
    while (end < text.length && text[end] !== " " && text[end] !== "\n") end++;
    if (cmdMap.has(text.slice(i + 1, end))) {
      regions.push({ start: i, end });
    }
  }

  for (const [display] of filePaths) {
    const token = "@" + display;
    let idx = 0;
    while ((idx = text.indexOf(token, idx)) !== -1) {
      regions.push({ start: idx, end: idx + token.length });
      idx += token.length;
    }
  }

  if (regions.length === 0) return null;
  regions.sort((a, b) => a.start - b.start);

  let html = "";
  let last = 0;
  for (const r of regions) {
    if (r.start < last) continue;
    if (r.start > last) html += esc(text.slice(last, r.start));
    html += `<span class="cmd-hl">${esc(text.slice(r.start, r.end))}</span>`;
    last = r.end;
  }
  if (last === 0) return null;
  if (last < text.length) html += esc(text.slice(last));
  return html;
}

export function useContentEditableEditor(cmdMap, insertedPathsRef, selectedId) {
  const [text, setText] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const editorRef = useRef(null);
  const lastHtmlRef = useRef("");
  const suppressInputRef = useRef(false);

  const applyColoring = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const html = colorize(text, cmdMap, insertedPathsRef.current);
    const target = html ?? esc(text);
    if (target !== lastHtmlRef.current) {
      const off = getCursorOffset(el);
      suppressInputRef.current = true;
      lastHtmlRef.current = target;
      el.innerHTML = target;
      setCursorOffset(el, off);
      queueMicrotask(() => { suppressInputRef.current = false; });
    }
  }, [text, cmdMap, insertedPathsRef]);

  useLayoutEffect(() => { applyColoring(); }, [applyColoring]);

  // Auto-focus the editor whenever the selection changes — including the
  // "new orchestrator" mode (+ clears selection) and switching between
  // agents. Lets users type immediately without a second click.
  useEffect(() => {
    editorRef.current?.focus();
  }, [selectedId]);

  const setTextAndSync = useCallback((newText, newCursor) => {
    suppressInputRef.current = true;
    setText(newText);
    setCursorPos(newCursor ?? newText.length);
    const el = editorRef.current;
    if (!el) return;
    const html = colorize(newText, cmdMap, insertedPathsRef.current);
    lastHtmlRef.current = html ?? esc(newText);
    el.innerHTML = lastHtmlRef.current;
    setCursorOffset(el, newCursor ?? newText.length);
    queueMicrotask(() => { suppressInputRef.current = false; });
  }, [cmdMap, insertedPathsRef]);

  const handleInput = () => {
    if (suppressInputRef.current) { suppressInputRef.current = false; return; }
    const el = editorRef.current;
    if (!el) return;
    let raw = el.innerText;
    if (raw === "\n") raw = "";
    const off = getCursorOffset(el);
    setText(raw);
    setCursorPos(off);
  };

  return {
    text,
    setText,
    cursorPos,
    setCursorPos,
    editorRef,
    applyColoring,
    setTextAndSync,
    handleInput,
  };
}
