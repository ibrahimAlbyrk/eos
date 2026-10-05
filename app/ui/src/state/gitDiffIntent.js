// One-shot "open the gitdiff panel focused on the Stashes section" intent.
// The composer's stash chip and the panel live in different subtrees; rather
// than thread a transient flag through the persisted panel data (which would
// stick), the chip sets this before opening and the shown viewer consumes it
// once, then it clears. A Changes tab stays mounted while hidden, so a request
// also bumps a counter the viewer subscribes to.
let pendingStashFocus = false;
let requests = 0;
const listeners = new Set();

export function requestStashFocus() {
  pendingStashFocus = true;
  requests += 1;
  for (const cb of listeners) cb();
}

export function consumeStashFocus() {
  const v = pendingStashFocus;
  pendingStashFocus = false;
  return v;
}

export function subscribeStashFocus(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export const stashFocusRequests = () => requests;
