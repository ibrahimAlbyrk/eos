// transcriptReveal — a tiny worker-keyed signal bus that lets the "Files in
// Chat" panel ask the transcript (which owns its own scroller refs) to scroll a
// given attachment's originating user message into view. Keyed by workerId so a
// request only reaches the transcript instance rendering that worker; the panel
// and the transcript live in different pane subtrees, so a shared signal is the
// clean seam (a DOM walk across sibling pane slots is not).

const listeners = new Map(); // workerId -> Set<fn(path)>

export function onReveal(workerId, fn) {
  if (!workerId) return () => {};
  let set = listeners.get(workerId);
  if (!set) { set = new Set(); listeners.set(workerId, set); }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) listeners.delete(workerId);
  };
}

export function requestReveal(workerId, path) {
  const set = listeners.get(workerId);
  if (!set) return;
  for (const fn of set) fn(path);
}
