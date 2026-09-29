// Which machine this dashboard drives. The app shell loads a view for another
// computer with window.__EOS_HOST = { id, name, remote: true, home, ... }; this
// Mac's own window has none. Components branch on these capabilities — never
// on how the view happened to be loaded.

export function currentHost() {
  return (typeof window !== "undefined" && window.__EOS_HOST) || null;
}

export function isRemoteView() {
  return currentHost()?.remote === true;
}

// Native pickers, Reveal in Finder and "open with" run on the daemon's screen —
// the wrong screen when this view controls another computer.
export function hasLocalScreen() {
  return !isRemoteView();
}
