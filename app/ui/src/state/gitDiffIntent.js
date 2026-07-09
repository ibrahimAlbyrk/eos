// One-shot "open the gitdiff panel focused on the Stashes section" intent.
// The composer's stash chip and the panel live in different subtrees; rather
// than thread a transient flag through the persisted panel data (which would
// stick), the chip sets this before opening and the viewer consumes it once on
// mount, then it clears. A plain module singleton is enough — only one panel
// opens per click, so there is no cross-instance race.
let pendingStashFocus = false;

export function requestStashFocus() {
  pendingStashFocus = true;
}

export function consumeStashFocus() {
  const v = pendingStashFocus;
  pendingStashFocus = false;
  return v;
}
