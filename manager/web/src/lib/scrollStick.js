export function shouldStick({ scrollHeight, scrollTop, clientHeight }, threshold = 40) {
  return (scrollHeight - scrollTop - clientHeight) < threshold;
}

export function shouldAutoScroll(isNearBottom, isProgrammatic, msSinceUserScroll, idleMs = 150) {
  if (isProgrammatic) return false;
  if (msSinceUserScroll <= idleMs) return false;
  return isNearBottom;
}
