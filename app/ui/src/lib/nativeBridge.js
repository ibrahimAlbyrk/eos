// Single chokepoint for the Eos.app WKWebView bridge. WKWebView never exposes
// absolute file paths to JS (clipboardData/dataTransfer carry blob copies
// only — a Finder folder even surfaces as a typeless empty File whose upload
// fails), so paths come from the native layer: a reply-style message handler
// reads the pasteboard for Cmd+V, and the app calls the window global below
// when Finder items are dropped on the webview.

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
const fileDropSubs = new Set();
let dropClaim = null;
// Where the last Finder drop landed. The native paths arrive after the DOM drop,
// so subscribers get it alongside them to pick the surface under the cursor.
let dropTarget = null;

window.__eosNativeDrop = (entries) => {
  const claim = dropClaim;
  const target = dropTarget;
  dropClaim = null;
  dropTarget = null;
  if (claim) return claim(entries);
  for (const cb of dropSubs) cb(entries, target);
};

// The native paths arrive async, after the DOM drop event. A surface that saw the
// DOM drop land on it (e.g. a terminal) claims the next native drop, so the paths
// go to it instead of the composer subscribers.
export function claimNextDrop(cb) {
  dropClaim = cb;
}

// cb(entries, dropTarget)
export function onNativeDrop(cb) {
  wireDomDrags();
  dropSubs.add(cb);
  return () => dropSubs.delete(cb);
}

// cb(element) while a Finder drag moves over the page, cb(null) once it leaves
// the window or drops.
export function onDragOver(cb) {
  wireDomDrags();
  dragSubs.add(cb);
  return () => dragSubs.delete(cb);
}

// A view of another computer gets no local paths (they mean nothing over there;
// the preload withholds them), so a Finder drop is read here as File objects and
// the caller uploads the bytes to that computer instead. cb(files, dropTarget)
export function onFileDrop(cb) {
  wireDomDrags();
  fileDropSubs.add(cb);
  return () => fileDropSubs.delete(cb);
}

let domDragsWired = false;

function wireDomDrags() {
  if (domDragsWired) return;
  domDragsWired = true;
  const remote = isRemoteView();
  const hasFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const hover = (el) => { for (const cb of dragSubs) cb(el); };
  document.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    if (remote) e.preventDefault(); // this Mac's own view: the preload accepts the drop
    hover(e.target);
  }, true);
  document.addEventListener("dragleave", (e) => {
    if (hasFiles(e) && !e.relatedTarget) hover(null);
  }, true);
  document.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    dropTarget = e.target;
    hover(null);
  }, true);
  if (!remote) return;
  // Bubble phase: a surface that handles its own drop (a terminal) stops it
  // before it reaches the composer subscribers.
  document.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    for (const cb of fileDropSubs) cb(files, e.target);
  });
}
