import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { findPlaceholders } from "../lib/placeholders.js";
import { isTriggerBoundary } from "../lib/triggerContext.js";

export function getCursorOffset(el) {
  const sel = window.getSelection();
  if (!sel.rangeCount || !el.contains(sel.anchorNode)) return 0;
  const range = sel.getRangeAt(0).cloneRange();
  range.selectNodeContents(el);
  range.setEnd(sel.anchorNode, sel.anchorOffset);
  return range.toString().length;
}

export function getSelectionOffsets(el) {
  const sel = window.getSelection();
  if (!sel.rangeCount || !el.contains(sel.anchorNode)) return { start: 0, end: 0 };
  const range = sel.getRangeAt(0);
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  pre.setEnd(range.endContainer, range.endOffset);
  return { start, end: pre.toString().length };
}

export function setSelectionOffsets(el, start, end) {
  const range = document.createRange();
  let pos = 0;
  let startSet = false;
  let endSet = false;
  function walk(node) {
    if (endSet) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.textContent.length;
      if (!startSet && start <= pos + len) {
        range.setStart(node, Math.max(0, start - pos));
        startSet = true;
      }
      if (startSet && end <= pos + len) {
        range.setEnd(node, Math.max(0, end - pos));
        endSet = true;
      }
      pos += len;
      return;
    }
    for (const child of node.childNodes) walk(child);
  }
  walk(el);
  if (!startSet) return;
  if (!endSet) range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function setCursorOffset(el, offset) {
  setSelectionOffsets(el, offset, offset);
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function slashRegions(cmdMap) {
  return (text) => {
    const regions = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== "/" || !isTriggerBoundary(text, i)) continue;
      let end = i + 1;
      while (end < text.length && text[end] !== " " && text[end] !== "\n") end++;
      if (cmdMap.has(text.slice(i + 1, end))) {
        regions.push({ start: i, end, cls: "cmd-hl" });
      }
    }
    return regions;
  };
}

function placeholderRegions(text) {
  return findPlaceholders(text).map(({ start, end }) => ({ start, end, cls: "tpl-hl" }));
}

function literalRegions(tokens) {
  return (text) => {
    const regions = [];
    for (const { token, cls } of tokens) {
      let idx = 0;
      while ((idx = text.indexOf(token, idx)) !== -1) {
        regions.push({ start: idx, end: idx + token.length, cls });
        idx += token.length;
      }
    }
    return regions;
  };
}

function colorize(text, scanners) {
  const regions = scanners.flatMap((scan) => scan(text));
  if (regions.length === 0) return null;
  regions.sort((a, b) => a.start - b.start);

  let html = "";
  let last = 0;
  for (const r of regions) {
    if (r.start < last) continue;
    if (r.start > last) html += esc(text.slice(last, r.start));
    html += `<span class="${r.cls}">${esc(text.slice(r.start, r.end))}</span>`;
    last = r.end;
  }
  if (last === 0) return null;
  if (last < text.length) html += esc(text.slice(last));
  return html;
}

export function useContentEditableEditor(cmdMap, insertedPathsRef, selectedId, attachItems = []) {
  const [text, setText] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const editorRef = useRef(null);
  const lastHtmlRef = useRef("");
  const suppressInputRef = useRef(false);

  const buildScanners = useCallback(() => [
    placeholderRegions,
    slashRegions(cmdMap),
    literalRegions([...insertedPathsRef.current.keys()].map((d) => ({ token: "@" + d, cls: "cmd-hl" }))),
    literalRegions(attachItems.map((it) => ({
      token: it.label,
      cls: it.status === "uploading" ? "att-hl att-hl-uploading" : "att-hl",
    }))),
  ], [cmdMap, insertedPathsRef, attachItems]);

  const applyColoring = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const html = colorize(text, buildScanners());
    const target = html ?? esc(text);
    if (target !== lastHtmlRef.current) {
      const off = getCursorOffset(el);
      suppressInputRef.current = true;
      lastHtmlRef.current = target;
      el.innerHTML = target;
      setCursorOffset(el, off);
      queueMicrotask(() => { suppressInputRef.current = false; });
    }
  }, [text, buildScanners]);

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
    const html = colorize(newText, buildScanners());
    lastHtmlRef.current = html ?? esc(newText);
    el.innerHTML = lastHtmlRef.current;
    setCursorOffset(el, newCursor ?? newText.length);
    queueMicrotask(() => { suppressInputRef.current = false; });
  }, [buildScanners]);

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
