// Single chokepoint for the Eos.app WKWebView bridge. WKWebView never exposes
// absolute file paths to JS (clipboardData/dataTransfer carry blob copies
// only — a Finder folder even surfaces as a typeless empty File whose upload
// fails), so paths come from the native layer: a reply-style message handler
// reads the pasteboard for Cmd+V, and the app calls the window globals below
// when Finder items are dragged over / dropped on the webview.

import { isRemoteView } from "./host.js";

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
let dropClaim = null;

window.__eosNativeDrop = (entries) => {
  const claim = dropClaim;
  dropClaim = null;
  if (claim) return claim(entries);
  for (const cb of dropSubs) cb(entries);
};

// The native paths arrive async, after the DOM drop event. A surface that saw the
// DOM drop land on it (e.g. a terminal) claims the next native drop, so the paths
// go to it instead of the composer subscribers.
export function claimNextDrop(cb) {
  dropClaim = cb;
}
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

// A view of another computer gets no local paths (they mean nothing over there;
// the preload withholds them), so a Finder drop is read here as File objects and
// the caller uploads the bytes to that computer instead.
const fileDropSubs = new Set();
let domDropsWired = false;

function wireDomDrops() {
  if (domDropsWired || !isRemoteView()) return;
  domDropsWired = true;
  const hasFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  document.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    for (const cb of dragSubs) cb(true);
  }, true);
  document.addEventListener("dragleave", (e) => {
    if (hasFiles(e) && !e.relatedTarget) for (const cb of dragSubs) cb(false);
  }, true);
  document.addEventListener("drop", (e) => {
    if (hasFiles(e)) for (const cb of dragSubs) cb(false);
  }, true);
  // Bubble phase: a surface that handles its own drop (a terminal) stops it
  // before it reaches the composer subscribers.
  document.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    for (const cb of fileDropSubs) cb(files);
  });
}

export function onFileDrop(cb) {
  wireDomDrops();
  fileDropSubs.add(cb);
  return () => fileDropSubs.delete(cb);
}
