// Most-recent-last stack of previously-selected agent ids. Lets agent deletion
// fall back to the agent that was selected *before* the deleted one. Pure and
// deterministic so SelectionProvider just owns the array — every transition
// lives here and is unit-tested.

export const SELECTION_HISTORY_CAP = 50;

// Record a selection change: push `prev` (the id we're leaving) onto the stack.
// Any stale copy of either id is removed first, so an id never appears twice and
// re-selecting can't bury a fresh entry. No-op when prev === next, or prev null.
export function pushSelection(history, prev, next, cap = SELECTION_HISTORY_CAP) {
  if (prev === next) return history;
  const pruned = history.filter((id) => id !== prev && id !== next);
  if (prev) pruned.push(prev);
  return pruned.length > cap ? pruned.slice(pruned.length - cap) : pruned;
}

// Pop the most-recent prior selection that still exists (per `exists`) and isn't
// `current`. Returns the surviving id (or null) and the trimmed history; every
// entry popped while searching — dead ones included — is dropped. Non-mutating.
export function takePrevious(history, exists, current) {
  const next = history.slice();
  while (next.length) {
    const id = next.pop();
    if (id && id !== current && (!exists || exists(id))) {
      return { id, history: next };
    }
  }
  return { id: null, history: next };
}
