// Find-in-page (⌘F) over the rendered transcript. Highlights use the CSS
// Custom Highlight API (Safari 17.2+) so the DOM is never mutated — React
// re-renders and dangerouslySetInnerHTML blocks stay untouched; ranges are
// simply rebuilt whenever content changes.
import { useCallback, useEffect, useRef, useState } from "react";
import { findAll } from "../lib/fileUtils.jsx";

const highlights = typeof CSS !== "undefined" ? CSS.highlights : null;

function clearHighlights() {
  if (!highlights) return;
  highlights.delete("page-find");
  highlights.delete("page-find-current");
}

function applyHighlights(ranges, current) {
  if (!highlights) return;
  highlights.set("page-find", new Highlight(...ranges.filter((_, i) => i !== current)));
  if (ranges[current]) highlights.set("page-find-current", new Highlight(ranges[current]));
  else highlights.delete("page-find-current");
}

// WKWebView never invalidates the paint of off-screen ::highlight tiles when the
// highlight registry shrinks, so stale blue marks survive above/below the viewport
// until scrolled into view. Toggling the content subtree's display tears down those
// cached tiles so they repaint clean; one synchronous task (scroll preserved) means
// the intermediate state never paints — no flash.
function evictStaleHighlightPaint(content, wrap) {
  if (!content) return;
  const scrollTop = wrap ? wrap.scrollTop : 0;
  content.style.display = "none";
  void content.offsetHeight; // force the layout drop before restoring
  content.style.display = "";
  if (wrap) wrap.scrollTop = scrollTop;
}

function collectRanges(root, query) {
  const ranges = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    for (const pos of findAll(node.textContent, query)) {
      const r = document.createRange();
      r.setStart(node, pos);
      r.setEnd(node, pos + query.length);
      if (r.getClientRects().length > 0) ranges.push(r); // skip display:none text
    }
  }
  return ranges;
}

export function usePageFind(contentRef, wrapRef, deps) {
  const [open, setOpen] = useState(false);
  const [query, setQueryRaw] = useState("");
  const [idx, setIdx] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const rangesRef = useRef([]);
  const lastScrollKeyRef = useRef(null);
  const paintedRef = useRef(0);
  const inputRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta || e.altKey || e.shiftKey) return;
      if (e.key !== "f" && e.key !== "F") return;
      e.preventDefault();
      setOpen(true);
      requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const scrollToRange = useCallback((range) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let rect = range.getBoundingClientRect();
    // A match inside a content-visibility-skipped block has no layout (zero
    // rect). Bring the block itself into view first — that renders its
    // contents — then the range measures true.
    if (rect.width === 0 && rect.height === 0) {
      const host = range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
      host?.closest("[data-bkey]")?.scrollIntoView({ block: "center" });
      rect = range.getBoundingClientRect();
    }
    const wrapRect = wrap.getBoundingClientRect();
    const top = wrap.scrollTop + (rect.top - wrapRect.top) - wrap.clientHeight / 2;
    // Plain scrollTo (not the programmatic-scroll guard): moving away from the
    // bottom must unpin stick-to-bottom or the next poll yanks back down.
    wrap.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }, [wrapRef]);

  useEffect(() => {
    if (!open || !query) {
      rangesRef.current = [];
      setMatchCount(0);
      lastScrollKeyRef.current = null;
      clearHighlights();
      if (paintedRef.current > 0) evictStaleHighlightPaint(contentRef.current, wrapRef.current);
      paintedRef.current = 0;
      return;
    }
    const root = contentRef.current;
    if (!root) return;
    const ranges = collectRanges(root, query);
    rangesRef.current = ranges;
    setMatchCount(ranges.length);
    const cur = ranges.length ? Math.min(idx, ranges.length - 1) : 0;
    if (cur !== idx) { setIdx(cur); return; }
    applyHighlights(ranges, cur);
    // Shrinking match set leaves stale paint on the dropped (possibly off-screen) ranges.
    if (ranges.length < paintedRef.current) evictStaleHighlightPaint(contentRef.current, wrapRef.current);
    paintedRef.current = ranges.length;
    // Scroll only when the target moved (new query or prev/next) — content
    // polls reapply highlights without re-centering the view.
    const key = query + ":" + cur;
    if (key !== lastScrollKeyRef.current) {
      lastScrollKeyRef.current = key;
      if (ranges[cur]) scrollToRange(ranges[cur]);
    }
  }, [open, query, idx, contentRef, scrollToRange, ...deps]);

  useEffect(() => clearHighlights, []);

  const move = useCallback((d) => {
    const n = rangesRef.current.length;
    if (n) setIdx((i) => (((i + d) % n) + n) % n);
  }, []);

  const setQuery = useCallback((q) => { setQueryRaw(q); setIdx(0); }, []);
  const next = useCallback(() => move(1), [move]);
  const prev = useCallback(() => move(-1), [move]);
  const close = useCallback(() => setOpen(false), []);

  return { open, query, idx, matchCount, inputRef, setQuery, next, prev, close };
}
