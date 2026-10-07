import { onNativeDrop, onFileDrop, onDragOver } from "./nativeBridge.js";

// Finder drops come in on one global bus (nativeBridge) while several composing
// surfaces can be mounted at once — a composer per split pane, plus a template
// editor over them. A drop, and the drag highlight, goes to the surface nearest
// to where it lands: walking up from the target, the first element that holds a
// surface's editor picks it. One that holds several (a drop outside every pane,
// e.g. on the sidebar) prefers the focused surface, then the newest.
//
// surface: { editor() → Element|null, focused() → bool, drop(entries),
//            dropFiles(files), setDragActive(bool) }
const surfaces = [];
let hovered = null;
let wired = false;

export function surfaceAt(list, target) {
  for (let el = target; el; el = el.parentNode) {
    const hits = list.filter((s) => el.contains(s.editor()));
    if (hits.length) return preferred(hits);
  }
  return preferred(list);
}

function preferred(list) {
  return list.findLast((s) => s.focused()) ?? list[list.length - 1] ?? null;
}

function setHovered(next) {
  if (next === hovered) return;
  hovered?.setDragActive(false);
  hovered = next;
  next?.setDragActive(true);
}

function wire() {
  if (wired) return;
  wired = true;
  onNativeDrop((entries, target) => surfaceAt(surfaces, target)?.drop(entries));
  onFileDrop((files, target) => surfaceAt(surfaces, target)?.dropFiles(files));
  onDragOver((el) => setHovered(el ? surfaceAt(surfaces, el) : null));
}

export function registerDropSurface(surface) {
  wire();
  surfaces.push(surface);
  return () => {
    const i = surfaces.indexOf(surface);
    if (i >= 0) surfaces.splice(i, 1);
    if (hovered === surface) hovered = null;
  };
}
