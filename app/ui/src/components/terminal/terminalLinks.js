import { api } from "../../api/client.js";

// → { kind: "web", url } | { kind: "file", path } | null for any other scheme.
export function resolveTerminalLink(uri) {
  let u;
  try { u = new URL(uri); } catch { return null; }
  if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:") return { kind: "web", url: u.href };
  if (u.protocol === "file:") return { kind: "file", path: decodeURIComponent(u.pathname) };
  return null;
}

// A plain click opens (no ⌘ needed). Web links go to the system browser (the
// app's window-open handler), files to their default app via the daemon.
export function openTerminalLink(_e, uri) {
  const link = resolveTerminalLink(uri);
  if (!link) return;
  if (link.kind === "web") window.open(link.url, "_blank", "noopener");
  else api.openFile(link.path).catch(() => {});
}

// xterm's own OSC 8 handling ignores file:// and opens web links via
// confirm() + window.open(), which the app shell blocks — so replace it.
export const oscLinkHandler = { allowNonHttpProtocols: true, activate: openTerminalLink };

// Path-looking runs of text, with an optional :line[:col] suffix (Claude Code's
// "src/a.ts:42") that stays part of the link but not of the path.
const PATH_RUN = /[\p{L}\p{N}_.~@+%=\-/]+(?::\d+){0,2}/gu;
const HOME = /^\/(?:Users|home)\/[^/]+/;

// → [{ index, length, path }] for runs that could name a file or folder: they
// contain a slash or end in an extension. Whether it exists is checked later.
export function findPathCandidates(text) {
  const out = [];
  for (const m of text.matchAll(PATH_RUN)) {
    let raw = m[0];
    let index = m.index;
    if (raw.startsWith("@")) { raw = raw.slice(1); index++; } // Claude Code's @file mentions
    raw = raw.replace(/\.+$/, ""); // sentence-ending period
    const path = raw.replace(/(?::\d+){1,2}$/, "");
    if (!/\p{L}/u.test(path) || path.startsWith("//")) continue; // no letters, or a URL's //host
    if (!path.includes("/") && !/\.[\p{L}\p{N}]+$/u.test(path)) continue;
    out.push({ index, length: raw.length, path });
  }
  return out;
}

// → normalized absolute path, or null when it can't be resolved (relative with
// no cwd, ~ when the cwd isn't under a home folder).
export function resolvePath(path, cwd) {
  let abs;
  if (path.startsWith("/")) abs = path;
  else if (path === "~" || path.startsWith("~/")) {
    const home = cwd?.match(HOME)?.[0];
    if (!home) return null;
    abs = home + path.slice(1);
  } else if (cwd) abs = `${cwd}/${path}`;
  else return null;
  const parts = [];
  for (const seg of abs.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

// A buffer line's text plus, per string index, the cells it covers (0-based
// start, exclusive end) — wide chars make string index and column diverge.
function lineCells(line) {
  let text = "";
  const cells = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    const width = cell?.getWidth();
    if (!width) continue; // right half of a wide char
    const chars = cell.getChars() || " ";
    text += chars;
    for (let i = 0; i < chars.length; i++) cells.push({ start: x, end: x + width });
  }
  return { text, cells };
}

// Plain-text file/folder paths become links. Relative ones resolve against the
// terminal's folder; only paths the daemon confirms exist get a link (answers
// cached briefly, so a file created a moment later still links). A click opens
// a folder in Finder and a file in its default app.
const STAT_TTL_MS = 5000;

export function createPathLinkProvider(term, getCwd) {
  const statCache = new Map(); // abs path -> { at, exists: Promise<boolean> }
  const exists = (abs) => {
    const hit = statCache.get(abs);
    if (hit && Date.now() - hit.at < STAT_TTL_MS) return hit.exists;
    if (statCache.size > 500) statCache.clear();
    const pending = api.statPath(abs).then(() => true, () => false);
    statCache.set(abs, { at: Date.now(), exists: pending });
    return pending;
  };
  return {
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line) { callback(undefined); return; }
      const { text, cells } = lineCells(line);
      const cwd = getCwd();
      const found = findPathCandidates(text)
        .map((c) => ({ ...c, abs: resolvePath(c.path, cwd) }))
        .filter((c) => c.abs);
      Promise.all(found.map((c) => exists(c.abs))).then((ok) => {
        callback(found.filter((_, i) => ok[i]).map((c) => ({
          text: text.slice(c.index, c.index + c.length),
          range: { start: { x: cells[c.index].start + 1, y }, end: { x: cells[c.index + c.length - 1].end, y } },
          activate: () => { api.openFile(c.abs).catch(() => {}); },
        })));
      });
    },
  };
}
