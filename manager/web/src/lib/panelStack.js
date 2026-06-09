// Right-panel navigation stack (file/agent/diff/commits viewers). Only the top
// entry is visible; closing it returns to the panel underneath — so a file
// opened from inside the agent viewer goes back to it on close. Each type
// appears at most once: opening a type already in the stack hoists it to the
// top, which keeps depth bounded and toggle buttons consistent. Pure and
// deterministic so SelectionProvider just owns the array — every transition
// lives here and is unit-tested.

export function openPanel(stack, type, data) {
  return [...stack.filter((p) => p.type !== type), { type, data }];
}

export function closePanel(stack, type) {
  if (!stack.some((p) => p.type === type)) return stack;
  return stack.filter((p) => p.type !== type);
}

export function popPanel(stack) {
  return stack.length ? stack.slice(0, -1) : stack;
}

export function topPanel(stack) {
  return stack.length ? stack[stack.length - 1] : null;
}

// Apply `updater` to the entry of `type` wherever it sits in the stack (a
// buried agent viewer must keep live-syncing while a file is on top). Returns
// the same reference when nothing changed so setState can bail out.
export function updatePanelData(stack, type, updater) {
  const idx = stack.findIndex((p) => p.type === type);
  if (idx === -1) return stack;
  const data = updater(stack[idx].data);
  if (data === stack[idx].data) return stack;
  const next = stack.slice();
  next[idx] = { type, data };
  return next;
}
