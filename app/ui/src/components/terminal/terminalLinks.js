import { api } from "../../api/client.js";
import { findPathCandidates, resolvePath } from "../../lib/pathLinks.js";
import { statPath } from "../../lib/pathStat.js";

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
// cached briefly — lib/pathStat.js — so a file created a moment later still
// links). A click opens a folder in Finder and a file in its default app.
export function createPathLinkProvider(term, getCwd) {
  const exists = (abs) => statPath(abs).then((s) => s != null);
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
