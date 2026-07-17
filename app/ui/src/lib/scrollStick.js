// Pure stick-to-bottom decisions for useStickToBottom — plain numbers in,
// plain numbers out, so every rule is unit-testable without a DOM.

export function shouldStick({ scrollHeight, scrollTop, clientHeight }, threshold = 40) {
  return (scrollHeight - scrollTop - clientHeight) < threshold;
}

// Pinned-state transition for one scroll event. Self events (our own follow
// writes) never change the state. Order matters: a clamp after content shrink
// drops scrollTop with no user intent but lands at distance 0, so "near bottom
// moving down" must not be required to KEEP a pin — only an upward move that
// ends beyond the threshold unpins. Re-pinning, however, requires a downward
// move, otherwise a gentle wheel-up that stays inside the threshold band would
// re-pin instantly and the follow loop would fight the user.
export function nextPinned(prev, { distance, deltaTop, isSelf, threshold = 40 }) {
  if (isSelf) return prev;
  if (prev) return !(deltaTop < 0 && distance >= threshold);
  return distance < threshold && deltaTop >= 0;
}

// One frame of the follow glide: exponential approach with dt-correction so
// speed is frame-rate independent. Never overshoots; snaps within snapPx so
// the tail doesn't crawl forever.
export function followStep(current, target, dtMs, { tau = 100, snapPx = 1 } = {}) {
  const dist = target - current;
  if (Math.abs(dist) <= snapPx) return target;
  return current + dist * (1 - Math.exp(-dtMs / tau));
}

// What a height change does to a pinned view. While SETTLING (right after a
// content swap/repositioning, when content-visibility block heights are still
// correcting from their estimates) the view snaps straight to the bottom — a
// glide would chase the receding target, the "slides down on agent switch"
// artifact. Outside settling, pinned growth glides as usual (streaming).
export function growthAction({ pinned, settling }) {
  if (!pinned) return "none";
  return settling ? "snap" : "follow";
}

// One per-frame reading of the settle watcher: settling is over once the
// height held still for `stableFrames` consecutive readings. Pass null to
// start; feed the returned state back in.
export function settleStep(state, height, { stableFrames = 2 } = {}) {
  if (state == null || height !== state.height) return { height, stable: 0, done: false };
  const stable = state.stable + 1;
  return { height, stable, done: stable >= stableFrames };
}
