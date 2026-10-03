// State behind a floating ⌘F find bar (FindBar): open/closed, the query and the
// current match. ⌘F opens the bar seeded with the selected text, like a browser.
import { useCallback, useRef, useState } from "react";
import { combo } from "../keymap/index.js";
import { useKeybinding } from "../keymap/useKeymap.js";

// A selection seeds the query only when it is one non-blank line (the trailing
// line break a triple-click selects is dropped).
export function selectionToQuery(text) {
  const line = text.replace(/\r?\n$/, "");
  return line.trim() && !line.includes("\n") ? line : "";
}

// The selected text and, for page text, its Range. Text selected inside the find
// bar's own input never counts.
function readSelection(findInput) {
  const el = document.activeElement;
  if (el === findInput) return { text: "", range: null };
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return { text: el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0), range: null };
  }
  const sel = window.getSelection();
  return { text: String(sel ?? ""), range: sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null };
}

// `when`/`priority` decide which find bar owns ⌘F (see useKeybinding); `deps`
// keep `when` fresh. `seed` is new on each ⌘F that picked up a selection: the
// find then starts at the first match at or after that selection.
export function useFind({ when, priority = 0 }, deps) {
  const [open, setOpen] = useState(false);
  const [query, setQueryRaw] = useState("");
  const [idx, setIdx] = useState(0);
  const [seed, setSeed] = useState(null);
  const inputRef = useRef(null);

  const setQuery = useCallback((q) => { setQueryRaw(q); setIdx(0); }, []);
  const show = useCallback(() => {
    const picked = readSelection(inputRef.current);
    const q = selectionToQuery(picked.text);
    if (q) setQuery(q);
    setSeed(q ? { range: picked.range } : null);
    setOpen(true);
    requestAnimationFrame(() => { inputRef.current?.focus({ preventScroll: true }); inputRef.current?.select(); });
  }, [setQuery]);
  const close = useCallback(() => setOpen(false), []);
  // Step through `count` matches, wrapping at both ends.
  const move = useCallback((d, count) => {
    if (count) setIdx((i) => (((i + d) % count) + count) % count);
  }, []);

  useKeybinding({
    match: combo("mod+f"),
    priority,
    when,
    run: (ctx, e) => { e.preventDefault(); show(); },
  }, deps);

  return { open, query, idx, seed, inputRef, setIdx, setQuery, show, close, move };
}
