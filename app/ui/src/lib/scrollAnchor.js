// Anchor-based scroll capture/restore for the transcript. The anchor is the
// first block (element carrying data-bkey) whose bottom crosses the viewport
// top, plus that block's offset from the viewport top. Restoring scrolls the
// same block back to the same offset, so the position survives event-window
// differences (pagination resets the window to the newest page on agent
// switch) and reflow — both of which invalidate an absolute scrollTop.

export function captureAnchor(scroller, content) {
  if (!scroller || !content) return null;
  const els = content.querySelectorAll("[data-bkey]");
  if (els.length === 0) return null;
  const viewTop = scroller.getBoundingClientRect().top;
  // Document order = vertical order in the flex column, so binary-search the
  // first block whose bottom is below the viewport top.
  let lo = 0, hi = els.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (els[mid].getBoundingClientRect().bottom > viewTop) { found = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  if (found === -1) return null;
  return {
    key: els[found].dataset.bkey,
    offset: els[found].getBoundingClientRect().top - viewTop,
  };
}

// Returns the scrollTop that puts the anchor block back at its captured
// offset, or null when the block is not in the rendered window.
export function resolveAnchorTop(scroller, content, { key, offset }) {
  if (!scroller || !content) return null;
  let el = null;
  for (const e of content.querySelectorAll("[data-bkey]")) {
    if (e.dataset.bkey === key) { el = e; break; }
  }
  if (!el) return null;
  const viewTop = scroller.getBoundingClientRect().top;
  return el.getBoundingClientRect().top - viewTop + scroller.scrollTop - offset;
}
