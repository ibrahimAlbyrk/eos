export const UNDO_MAX = 100;

// Pure undo/redo stack for the composer. A snapshot is an opaque value
// ({text, cursorPos, insertedPaths}); the stack never inspects its fields.
// `index` points at the snapshot the editor currently shows. `open` marks the
// top snapshot as still coalescible — a typing burst keeps overwriting one
// checkpoint until a quiescence window closes it (see settle), so rapid keys
// collapse into a single undo step while a discrete edit stands alone.

export function initUndo(baseline = { text: "", cursorPos: 0, insertedPaths: [] }) {
  return { snapshots: [baseline], index: 0, open: false };
}

// A fresh edit after an undo abandons the redo branch.
function truncateRedo(state) {
  if (state.index >= state.snapshots.length - 1) return state;
  return { ...state, snapshots: state.snapshots.slice(0, state.index + 1) };
}

// Typing: replace the open top (coalesce the burst), else open a new checkpoint
// so the pre-burst state survives at index-1.
export function recordCoalescing(state, snap) {
  const s = truncateRedo(state);
  if (s.open) {
    const snapshots = s.snapshots.slice();
    snapshots[s.index] = snap;
    return { snapshots, index: s.index, open: true };
  }
  return { snapshots: [...s.snapshots, snap], index: s.index + 1, open: true };
}

// Programmatic edit (template, @path, paste, recall): always its own step.
export function recordDiscrete(state, snap) {
  const s = truncateRedo(state);
  return { snapshots: [...s.snapshots, snap], index: s.index + 1, open: false };
}

// The quiescence window fired — seal the top so the next key starts a checkpoint.
export function settle(state) {
  return state.open ? { ...state, open: false } : state;
}

export function undo(state) {
  if (state.index <= 0) return { state: { ...state, open: false }, snapshot: null };
  const index = state.index - 1;
  return { state: { ...state, index, open: false }, snapshot: state.snapshots[index] };
}

export function redo(state) {
  if (state.index >= state.snapshots.length - 1) return { state: { ...state, open: false }, snapshot: null };
  const index = state.index + 1;
  return { state: { ...state, index, open: false }, snapshot: state.snapshots[index] };
}

// Cap retained history; drop oldest and shift index to keep it pointing at the
// same snapshot.
export function bound(state, max = UNDO_MAX) {
  const overflow = state.snapshots.length - max;
  if (overflow <= 0) return state;
  return {
    snapshots: state.snapshots.slice(overflow),
    index: Math.max(0, state.index - overflow),
    open: state.open,
  };
}

export function canUndo(state) {
  return state.index > 0;
}

export function canRedo(state) {
  return state.index < state.snapshots.length - 1;
}
