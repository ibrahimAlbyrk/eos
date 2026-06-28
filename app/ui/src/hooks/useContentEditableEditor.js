import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { findPlaceholders } from "../lib/placeholders.js";
import { findSlashTokens } from "../lib/slashTokens.js";
import { findLabelRegions } from "../lib/attachmentTokens.js";
import { listMarkers } from "../lib/markdownBlocks.js";
import { initUndo, recordCoalescing, recordDiscrete, settle, undo as undoStack, redo as redoStack, bound } from "../lib/undoStack.js";

const SETTLE_MS = 300; // typing quiescence that seals an undo checkpoint

// ── DOM ↔ model linearization (single source of truth) ────────────────────
// The composer's text lives in a model string; the contentEditable DOM is a
// projection of it (colorize → inline spans + literal "\n"). Reading the text
// AND the caret back must use ONE newline rule or they desync: the old code
// took text from el.innerText (which DOES count the block-level breaks that
// native paste/Enter transiently produce as <div>/<br>) but the caret from
// Range.toString (which counts NONE of them — it only concatenates Text node
// data). So any offset captured while the DOM held block breaks was short by
// the line count, dropping the caret into the middle of pasted/recalled text.
// linearize is that single rule: one walk yields the model text and locates
// any DOM points under the same accounting.
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const BLOCK_TAGS = new Set(["DIV", "P"]);

// Walk `el` in document order, building the model string (Text data verbatim;
// <br> and block-element boundaries → "\n", matching innerText). For each
// {node, offset} in `points`, capture the model offset at that DOM position.
// A point on an unvisited node (or past the end) clamps to the text length.
export function linearize(el, points = []) {
  let text = "";
  const offsets = points.map(() => null);
  const mark = (node, offset) => {
    for (let i = 0; i < points.length; i++) {
      if (offsets[i] === null && points[i].node === node && points[i].offset === offset) {
        offsets[i] = text.length;
      }
    }
  };
  const walk = (node) => {
    if (node.nodeType === TEXT_NODE) {
      const data = node.data ?? "";
      for (let i = 0; i < points.length; i++) {
        if (offsets[i] === null && points[i].node === node) {
          offsets[i] = text.length + Math.min(points[i].offset, data.length);
        }
      }
      text += data;
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    if (node.tagName === "BR") { mark(node, 0); text += "\n"; return; }
    if (BLOCK_TAGS.has(node.tagName) && text !== "" && !text.endsWith("\n")) text += "\n";
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) { mark(node, i); walk(kids[i]); }
    mark(node, kids.length);
  };
  walk(el);
  for (let i = 0; i < offsets.length; i++) if (offsets[i] === null) offsets[i] = text.length;
  return { text, offsets };
}

// One read of the live editor → {text, caret} from the SAME walk, so stored
// text and caret can never use different newline accounting (the bug's root).
export function readEditor(el) {
  const sel = window.getSelection();
  const anchored = sel.rangeCount && el.contains(sel.anchorNode);
  const pts = anchored ? [{ node: sel.anchorNode, offset: sel.anchorOffset }] : [];
  const { text, offsets } = linearize(el, pts);
  return { text, caret: anchored ? offsets[0] : text.length };
}

export function getCursorOffset(el) {
  const sel = window.getSelection();
  if (!sel.rangeCount || !el.contains(sel.anchorNode)) return 0;
  return linearize(el, [{ node: sel.anchorNode, offset: sel.anchorOffset }]).offsets[0];
}

export function getSelectionOffsets(el) {
  const sel = window.getSelection();
  if (!sel.rangeCount || !el.contains(sel.anchorNode)) return { start: 0, end: 0 };
  const r = sel.getRangeAt(0);
  const { offsets } = linearize(el, [
    { node: r.startContainer, offset: r.startOffset },
    { node: r.endContainer, offset: r.endOffset },
  ]);
  return { start: offsets[0], end: offsets[1] };
}

// Inverse of linearize: place a model [start,end] range back onto the DOM. Only
// ever called on canonical (colorized) DOM — inline spans + literal "\n", no
// block breaks — so counting Text length here matches linearize's accounting.
export function setSelectionOffsets(el, start, end) {
  const range = document.createRange();
  let pos = 0;
  let startSet = false;
  let endSet = false;
  function walk(node) {
    if (endSet) return;
    if (node.nodeType === TEXT_NODE) {
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
  if (!startSet) {
    if (pos === 0) return; // empty editor — leave the selection untouched
    // The model's trailing "\n" is projected as a filler <br> (WebKit won't
    // render a final literal newline), so an end-of-text offset lands past the
    // last text node — collapse the caret onto that empty final line.
    range.selectNodeContents(el);
    range.collapse(false);
  } else if (!endSet) {
    range.collapse(true);
  }
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function setCursorOffset(el, offset) {
  setSelectionOffsets(el, offset, offset);
}

// Pure: how far to move scrollTop so [top,bottom] sits inside [boxTop,boxBottom]
// with a margin. Negative → scroll up, positive → scroll down. Layout-free → unit-testable.
export function scrollDelta(top, bottom, boxTop, boxBottom, margin = 8) {
  if (top < boxTop + margin) return top - (boxTop + margin);
  if (bottom > boxBottom - margin) return bottom - (boxBottom - margin);
  return 0;
}

// Scroll the current selection into view within the `el` scroll container.
// Programmatic Selection changes don't auto-scroll (unlike typing), so Tab/Shift+Tab
// placeholder navigation needs this to reveal off-screen {{fields}}.
export function scrollSelectionIntoView(el) {
  const sel = window.getSelection();
  if (!sel.rangeCount || !el.contains(sel.anchorNode)) return;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  const box = el.getBoundingClientRect();
  el.scrollTop += scrollDelta(rect.top, rect.bottom, box.top, box.bottom);
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function slashRegions(cmdMap) {
  return (text) => findSlashTokens(text, cmdMap).map(({ start, end, name }) => ({
    start,
    end,
    cls: "cmd-pill",
    attrs: { "data-cmd": name, "data-popover-trigger": "slashinfo" },
  }));
}

// Collapsed-paste pills. The placeholder is literal text in the model; the
// data-paste attr carries it back so the composer's click/hover delegation can
// look the full text up in pastesRef (expand-to-edit, hover preview).
function pasteRegions(pastesRef) {
  return (text) => findLabelRegions(text, [...pastesRef.current.keys()]).map(({ start, end }) => ({
    start,
    end,
    cls: "paste-pill",
    attrs: { "data-paste": text.slice(start, end), "data-popover-trigger": "pasteinfo" },
  }));
}

function placeholderRegions(text) {
  return findPlaceholders(text).map(({ start, end }) => ({ start, end, cls: "tpl-hl" }));
}

// List-marker glyphs ("-"/"*"/"1.") styled in place — the literal char stays in
// the text (offset round-trip untouched), CSS overlays a bullet. Depth caps at
// the highest md-d* class the stylesheet defines.
function listRegions(text) {
  return listMarkers(text).map(({ start, end, depth, ordered }) => ({
    start,
    end,
    cls: ordered ? "md-num" : `md-bullet md-d${Math.min(depth, 5)}`,
  }));
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

function attrsHtml(attrs) {
  if (!attrs) return "";
  return Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${esc(v).replace(/"/g, "&quot;")}"`)
    .join("");
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
    html += `<span class="${r.cls}"${attrsHtml(r.attrs)}>${esc(text.slice(r.start, r.end))}</span>`;
    last = r.end;
  }
  if (last === 0) return null;
  if (last < text.length) html += esc(text.slice(last));
  return html;
}

// Model text → editor innerHTML: colorize (or escape when nothing matches),
// then make a trailing newline visible. WebKit won't render a final literal
// "\n" in white-space:pre-wrap — the empty last line collapses and the caret
// jumps up to the previous line — so the trailing "\n" is projected as a <br>.
// linearize already reads <br> back as "\n", so the model round-trip is intact.
export function toHtml(text, scanners) {
  let html = colorize(text, scanners) ?? esc(text);
  if (text.endsWith("\n")) html = html.replace(/\n$/, "<br>");
  return html;
}

// Native ⌘Z/⌘⇧Z are forwarded through window globals. More than one editor can
// be mounted (composer + an open template editor); this stack routes the globals
// to the topmost (most recently mounted) so closing the modal restores the
// composer's undo. One shared subscription, set up lazily, never torn down.
const undoTargets = [];
let undoWired = false;
function ensureUndoDispatch() {
  if (undoWired) return;
  undoWired = true;
  window.__eosUndo = () => undoTargets[undoTargets.length - 1]?.undo();
  window.__eosRedo = () => undoTargets[undoTargets.length - 1]?.redo();
}

export function useContentEditableEditor(cmdMap, insertedPathsRef, selectedId, attachItems = [], reconcileAttachments, pastesRef) {
  const [text, setText] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const editorRef = useRef(null);
  const lastHtmlRef = useRef("");
  const suppressInputRef = useRef(false);
  const undoRef = useRef(initUndo());
  const settleTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(settleTimerRef.current), []);

  const buildScanners = useCallback(() => [
    placeholderRegions,
    listRegions,
    slashRegions(cmdMap),
    literalRegions([...insertedPathsRef.current.keys()].map((d) => ({ token: "@" + d, cls: "cmd-hl" }))),
    literalRegions(attachItems.map((it) => ({
      token: it.label,
      cls: it.status === "uploading" ? "att-hl att-hl-uploading" : "att-hl",
    }))),
    ...(pastesRef ? [pasteRegions(pastesRef)] : []),
  ], [cmdMap, insertedPathsRef, attachItems, pastesRef]);

  const applyColoring = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const target = toHtml(text, buildScanners());
    if (target !== lastHtmlRef.current) {
      const off = getCursorOffset(el);
      const focused = document.activeElement === el;
      suppressInputRef.current = true;
      lastHtmlRef.current = target;
      el.innerHTML = target;
      setCursorOffset(el, off);
      // The innerHTML rebuild resets scrollTop, and the programmatic caret
      // restore doesn't auto-scroll — reveal the caret so a long paste/edit
      // doesn't leave the view pinned to the top with the cursor off-screen
      // at the bottom. Focused-only: an unfocused recolor must not yank scroll.
      if (focused) scrollSelectionIntoView(el);
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

  const snap = useCallback((newText, newCursor) => ({
    text: newText,
    cursorPos: newCursor ?? newText.length,
    insertedPaths: insertedPathsRef?.current ? [...insertedPathsRef.current] : [],
    pastes: pastesRef?.current ? [...pastesRef.current] : [],
  }), [insertedPathsRef, pastesRef]);

  // Writes text → state + DOM (re-colored, cursor restored) WITHOUT touching the
  // undo stack. setTextAndSync layers recording on top; undo/redo reuse it bare
  // so applying a snapshot never records a fresh one.
  const writeEditor = useCallback((newText, newCursor) => {
    suppressInputRef.current = true;
    setText(newText);
    setCursorPos(newCursor ?? newText.length);
    const el = editorRef.current;
    if (!el) return;
    lastHtmlRef.current = toHtml(newText, buildScanners());
    el.innerHTML = lastHtmlRef.current;
    setCursorOffset(el, newCursor ?? newText.length);
    queueMicrotask(() => { suppressInputRef.current = false; });
  }, [buildScanners]);

  // recordMode: "discrete" (default) = one undo step; "reset" = new baseline
  // (send-clear, agent switch) so undo never crosses messages/agents.
  const setTextAndSync = useCallback((newText, newCursor, recordMode = "discrete") => {
    writeEditor(newText, newCursor);
    clearTimeout(settleTimerRef.current);
    const s = snap(newText, newCursor);
    undoRef.current = recordMode === "reset"
      ? initUndo(s)
      : bound(recordDiscrete(undoRef.current, s));
  }, [writeEditor, snap]);

  const applySnapshot = (s) => {
    if (insertedPathsRef) insertedPathsRef.current = new Map(s.insertedPaths ?? []);
    if (pastesRef) pastesRef.current = new Map(s.pastes ?? []);
    reconcileAttachments?.(s.text); // re-seat/drop chips to match the restored text
    writeEditor(s.text, s.cursorPos);
  };

  const undo = () => {
    clearTimeout(settleTimerRef.current);
    const r = undoStack(undoRef.current);
    undoRef.current = r.state;
    if (r.snapshot) applySnapshot(r.snapshot);
  };

  const redo = () => {
    clearTimeout(settleTimerRef.current);
    const r = redoStack(undoRef.current);
    undoRef.current = r.state;
    if (r.snapshot) applySnapshot(r.snapshot);
  };

  // The macOS Edit menu owns ⌘Z/⌘⇧Z (app/main.swift) — a menu key-equivalent is
  // consumed before the WebView's keydown, so the native side forwards here.
  // Mirrors the window.__eosNativeDrop bridge; latest handler via a ref. When a
  // second editor mounts (template editor over the composer) it takes the globals
  // via the stack and hands them back on unmount — never deletes them.
  const undoFnRef = useRef(undo);
  const redoFnRef = useRef(redo);
  undoFnRef.current = undo;
  redoFnRef.current = redo;
  useEffect(() => {
    ensureUndoDispatch();
    const entry = { undo: () => undoFnRef.current(), redo: () => redoFnRef.current() };
    undoTargets.push(entry);
    return () => {
      const i = undoTargets.indexOf(entry);
      if (i >= 0) undoTargets.splice(i, 1);
    };
  }, []);

  const handleInput = () => {
    if (suppressInputRef.current) { suppressInputRef.current = false; return; }
    const el = editorRef.current;
    if (!el) return;
    let { text: raw, caret } = readEditor(el);
    if (raw === "\n") { raw = ""; caret = 0; }
    setText(raw);
    setCursorPos(caret);
    undoRef.current = bound(recordCoalescing(undoRef.current, snap(raw, caret)));
    clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => {
      undoRef.current = settle(undoRef.current);
    }, SETTLE_MS);
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
    undo,
    redo,
  };
}
