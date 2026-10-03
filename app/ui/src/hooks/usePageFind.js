// Find-in-page (⌘F) over rendered DOM — the transcript, a markdown preview.
// Highlights use the CSS Custom Highlight API (Safari 17.2+) so the DOM is never
// mutated — React re-renders and dangerouslySetInnerHTML blocks stay untouched;
// ranges are simply rebuilt whenever content changes.
import { useCallback, useEffect, useRef, useState } from "react";
import { findAll } from "../lib/fileUtils.jsx";
import { glideToBlock } from "../lib/glideTo.js";
import { useFind } from "./useFind.js";

const highlights = typeof CSS !== "undefined" ? CSS.highlights : null;

function clearHighlights(name) {
  if (!highlights) return;
  highlights.delete(name);
  highlights.delete(name + "-current");
}

function applyHighlights(name, ranges, current) {
  if (!highlights) return;
  highlights.set(name, new Highlight(...ranges.filter((_, i) => i !== current)));
  if (ranges[current]) highlights.set(name + "-current", new Highlight(ranges[current]));
  else highlights.delete(name + "-current");
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

// Index of the first range starting at or after `from`; 0 when there is none.
function firstAtOrAfter(ranges, from) {
  const i = ranges.findIndex((r) => {
    try { return r.compareBoundaryPoints(Range.START_TO_START, from) >= 0; } catch { return false; }
  });
  return Math.max(i, 0);
}

// The highlight + scroll half of a DOM find: marks every `query` match under
// contentRef (registered as `name` and `name`-current) and glides wrapRef to
// match `idx`. A new query or `seed` (see useFind) starts at the first match at
// or after the seeded selection. Returns the match count.
// `hold` unpins the scroller's stick-to-bottom before a jump; without it the
// follow loop drags a pinned view straight back to the bottom.
export function useDomFind({ contentRef, wrapRef, deps, enabled, open, query, idx, setIdx, seed = null, hold = null, name = "page-find" }) {
  const [matchCount, setMatchCount] = useState(0);
  const lastScrollKeyRef = useRef(null);
  const placedRef = useRef(null);
  const paintedRef = useRef(0);
  const cancelGlideRef = useRef(null);

  const scrollToRange = useCallback((range) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    hold?.();
    cancelGlideRef.current?.();
    const rect = range.getBoundingClientRect();
    // A match inside a content-visibility-skipped block has no layout (zero
    // rect). Bring the block itself into view first — that renders its
    // contents — then the glide measures the range true.
    if (rect.width === 0 && rect.height === 0) {
      const host = range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
      host?.closest("[data-bkey]")?.scrollIntoView({ block: "center" });
    }
    cancelGlideRef.current = glideToBlock(wrap, range, wrap.clientHeight / 2);
  }, [wrapRef, hold]);

  useEffect(() => {
    // CSS.highlights is a global registry — a parked pane must not touch it or it
    // would wipe the active pane's matches.
    if (!enabled) return;
    if (!open || !query) {
      setMatchCount(0);
      lastScrollKeyRef.current = null;
      clearHighlights(name);
      if (paintedRef.current > 0) evictStaleHighlightPaint(contentRef.current, wrapRef.current);
      paintedRef.current = 0;
      return;
    }
    const root = contentRef.current;
    if (!root) return;
    const ranges = collectRanges(root, query);
    setMatchCount(ranges.length);
    if (seed?.range && (placedRef.current?.seed !== seed || placedRef.current.query !== query)) {
      placedRef.current = { seed, query };
      const at = firstAtOrAfter(ranges, seed.range);
      if (at !== idx) { setIdx(at); return; }
    }
    const cur = ranges.length ? Math.min(idx, ranges.length - 1) : 0;
    if (cur !== idx) { setIdx(cur); return; }
    applyHighlights(name, ranges, cur);
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
  }, [enabled, open, query, idx, setIdx, seed, name, contentRef, scrollToRange, ...deps]);

  useEffect(() => () => { clearHighlights(name); cancelGlideRef.current?.(); }, [name]);

  return matchCount;
}

// The transcript's find. Only the active transcript pane owns ⌘F (parked
// keep-alive panes stay mounted, so without the `when` gate every pane would
// grab it at once). Priority 0 = the DEFAULT owner: a focused docked panel with
// its own find (FileViewer, priority 10) outranks it; panels without one fall
// through here.
export function usePageFind(contentRef, wrapRef, deps, enabled = true, hold = null) {
  const { open, query, idx, seed, inputRef, setIdx, setQuery, close, move } = useFind({ when: () => enabled }, [enabled]);
  const matchCount = useDomFind({ contentRef, wrapRef, deps, enabled, open, query, idx, setIdx, seed, hold });
  const next = useCallback(() => move(1, matchCount), [move, matchCount]);
  const prev = useCallback(() => move(-1, matchCount), [move, matchCount]);
  return { open, query, idx, matchCount, inputRef, setQuery, next, prev, close };
}
