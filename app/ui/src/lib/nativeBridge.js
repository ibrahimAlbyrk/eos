// Single chokepoint for the Eos.app WKWebView bridge. WKWebView never exposes
// absolute file paths to JS (clipboardData/dataTransfer carry blob copies
// only — a Finder folder even surfaces as a typeless empty File whose upload
// fails), so paths come from the native layer: a reply-style message handler
// reads the pasteboard for Cmd+V, and the app calls the window globals below
// when Finder items are dragged over / dropped on the webview.

export function hasPasteboardBridge() {
  return !!window.webkit?.messageHandlers?.pasteboardPaths;
}

// → [{path, isDir}] | null when the bridge is unavailable/failed.
export async function readPasteboardPaths() {
  const handler = window.webkit?.messageHandlers?.pasteboardPaths;
  if (!handler) return null;
  try {
    const entries = await handler.postMessage(null);
    return Array.isArray(entries) ? entries : [];
  } catch {
    return null;
  }
}

const dropSubs = new Set();
const dragSubs = new Set();

window.__eosNativeDrop = (entries) => {
  for (const cb of dropSubs) cb(entries);
};
window.__eosDragState = (active) => {
  for (const cb of dragSubs) cb(active);
};

export function onNativeDrop(cb) {
  dropSubs.add(cb);
  return () => dropSubs.delete(cb);
}

export function onDragState(cb) {
  dragSubs.add(cb);
  return () => dragSubs.delete(cb);
}
