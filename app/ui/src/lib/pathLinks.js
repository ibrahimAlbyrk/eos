// File and folder paths in text: finding them, resolving them, and drawing the
// ones that exist as chips in rendered chat prose. The terminal's link provider
// and assistant messages share it; whether a path exists comes from
// lib/pathStat.js.

import { escapeHtml } from "./markdown.js";
import { glyphSvg } from "./fileGlyphs.js";

// Path-looking runs of text, with an optional :line[:col] or :line-endLine
// suffix (Claude Code's "src/a.ts:42") that stays part of the link but not of
// the path.
const PATH_RUN = /[\p{L}\p{N}_.~@+%=\-/]+(?::\d+(?:[-–]\d+)?){0,2}/gu;
const LOCATION = /:(\d+)(?:[-–](\d+)|:(\d+))?$/;
const HOME = /^\/(?:Users|home)\/[^/]+/;
const HAS_EXT = /\.[\p{L}\p{N}]+$/u;

// "src/a.ts:42:7" → { path: "src/a.ts", line: 42, column: 7 };
// "src/a.ts:42-47" → { path, line: 42, endLine: 47 }; no suffix → { path }.
export function parseLocation(raw) {
  const m = LOCATION.exec(raw);
  if (!m) return { path: raw };
  const loc = { path: raw.slice(0, m.index), line: Number(m[1]) };
  if (m[2]) loc.endLine = Number(m[2]);
  if (m[3]) loc.column = Number(m[3]);
  return loc;
}

// Could this name a file or folder: it has letters and a slash or an extension,
// and is not a URL's //host.
function pathShaped(path) {
  if (!/\p{L}/u.test(path) || path.startsWith("//")) return false;
  return path.includes("/") || HAS_EXT.test(path);
}

// → [{ index, length, path, line?, column?, endLine? }] for runs that could
// name a file or folder. Whether it exists is checked later.
export function findPathCandidates(text) {
  const out = [];
  for (const m of text.matchAll(PATH_RUN)) {
    let raw = m[0];
    let index = m.index;
    if (raw.startsWith("@")) { raw = raw.slice(1); index++; } // Claude Code's @file mentions
    raw = raw.replace(/\.+$/, ""); // sentence-ending period
    const loc = parseLocation(raw);
    if (!pathShaped(loc.path)) continue;
    out.push({ index, length: raw.length, ...loc });
  }
  return out;
}

// The whole text of an inline code span (or a link's href) as a path, or null:
// `file://` URIs and @mentions included; spaces only in an absolute or ~ path;
// globs, code and URLs are not paths.
export function codeSpanPath(text) {
  let raw = text.trim();
  if (raw.startsWith("file://")) {
    try { raw = decodeURIComponent(new URL(raw).pathname); } catch { return null; }
  } else if (raw.startsWith("@")) {
    raw = raw.slice(1);
  }
  if (!raw || raw.length > 1024 || /[\n<>"'`|*?{};,=$\\]/.test(raw)) return null;
  if (/\s/.test(raw) && !/^~?\//.test(raw)) return null;
  const loc = parseLocation(raw);
  if (/^[a-z][a-z0-9+.-]*:/i.test(loc.path)) return null; // a URL scheme
  return pathShaped(loc.path) ? loc : null;
}

// "/Users/me" from a folder under it, or null.
export const homeOf = (cwd) => cwd?.match(HOME)?.[0] ?? null;

// → normalized absolute path, or null when it can't be resolved (relative with
// no cwd, ~ when the cwd isn't under a home folder).
export function resolvePath(path, cwd) {
  let abs;
  if (path.startsWith("/")) abs = path;
  else if (path === "~" || path.startsWith("~/")) {
    const home = homeOf(cwd);
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

// An absolute or ~ path names one place whatever the agent's folder — only
// those can be called missing.
export const isRootedPath = (path) => path.startsWith("/") || path === "~" || path.startsWith("~/");

const MAX_SHOWN = 48;

// How a chip shows a path as written: the agent's folder dropped, the home
// folder as ~, and — past MAX_SHOWN characters — the middle folded to "…/" so
// the parent folder and the name stay. `shorten: false` keeps it as written.
// → { dir, base } (a folder's base ends in "/").
export function displayParts(path, { cwd, type, shorten = true } = {}) {
  let shown = path;
  if (shorten && shown.startsWith("/")) {
    const home = homeOf(cwd);
    if (cwd && shown.startsWith(cwd + "/")) shown = shown.slice(cwd.length + 1);
    else if (home && (shown === home || shown.startsWith(home + "/"))) shown = "~" + shown.slice(home.length);
  }
  const trimmed = shown.replace(/\/+$/, "");
  if (!trimmed) return { dir: "", base: shown };
  const cut = trimmed.lastIndexOf("/");
  let dir = trimmed.slice(0, cut + 1);
  const base = trimmed.slice(cut + 1) + (type === "directory" ? "/" : "");
  if (shorten && dir.length + base.length > MAX_SHOWN) {
    const parent = dir.slice(0, -1).split("/").pop();
    dir = parent && parent.length + base.length + 3 <= MAX_SHOWN ? `…/${parent}/` : "…/";
  }
  return { dir, base };
}

// ":42", ":42:7", ":42–47" or "".
export function locationLabel({ line, column, endLine }) {
  if (!line) return "";
  if (endLine) return `:${line}–${endLine}`;
  return column ? `:${line}:${column}` : `:${line}`;
}

const escapeAttr = (s) => escapeHtml(String(s)).replace(/"/g, "&quot;");

// The data-* attributes every path element in prose carries — what the click,
// hover and right-click handlers read back (readPathRef).
function pathDataAttrs({ abs, type, line, column, endLine }) {
  let attrs = ` data-path="${escapeAttr(abs)}" data-type="${type}"`;
  if (line) attrs += ` data-line="${line}"`;
  if (column) attrs += ` data-col="${column}"`;
  if (endLine) attrs += ` data-end="${endLine}"`;
  return attrs;
}

// Back from a path element: { path, type, line?, column?, endLine? }.
export function readPathRef(el) {
  const num = (v) => (v ? Number(v) : undefined);
  return {
    path: el.dataset.path,
    type: el.dataset.type === "directory" ? "directory" : "file",
    line: num(el.dataset.line),
    column: num(el.dataset.col),
    endLine: num(el.dataset.end),
  };
}

export const PATH_ELEMENT_SELECTOR = ".path-chip, .path-link";

// One chip: the type glyph, the folder dimmed, the name, the :line.
export function pathChipHtml(hit, { cwd, shorten = true, title = false } = {}) {
  const { dir, base } = displayParts(hit.written, { cwd, type: hit.type, shorten });
  const loc = locationLabel(hit);
  const label = hit.abs + loc;
  const tip = title ? ` title="${escapeAttr(label)}"` : "";
  return `<button type="button" class="path-chip"${pathDataAttrs(hit)} aria-label="${escapeAttr(label)}"${tip}>`
    + glyphSvg({ type: hit.type, name: base }, { className: "path-chip-icon" })
    + (dir ? `<span class="path-chip-dir">${escapeHtml(dir)}</span>` : "")
    + `<span class="path-chip-base">${escapeHtml(base)}</span>`
    + (loc ? `<span class="path-chip-loc">${loc}</span>` : "")
    + "</button>";
}

const ENTITY = /&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot|#39|nbsp));/gi;
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
const decodeHtml = (s) =>
  s.replace(ENTITY, (m, dec, hex, name) =>
    dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : NAMED[name.toLowerCase()] ?? m);

const attrOf = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decodeHtml(m[1]) : null;
};

// A link to a place on disk rather than the web: no scheme (a relative or
// absolute path), or file://. Fragment-only links stay in the page.
export function isLocalHref(href) {
  if (!href || href.startsWith("#")) return false;
  return href.startsWith("file://") || !/^[a-z][a-z0-9+.-]*:/i.test(href);
}

// Walks sanitized markdown HTML (marked + DOMPurify, so well-formed) and hands
// each candidate to a visitor, which may return replacement markup:
//   code(text, loc)     — an inline code span that reads as a path
//   text(text, cands)   — a run of prose text with path candidates
//   link(tag, loc)      — an <a> whose href is a path (returns a new open tag)
// Code blocks, links' insides and buttons (copy buttons, artifact chips) are
// left alone.
function walkProse(html, visit) {
  const parts = html.split(/(<[^>]*>)/);
  let pre = 0;
  let code = 0;
  let anchor = 0;
  let button = 0;
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith("<")) {
      const tag = /^<\/?([a-z0-9]+)/i.exec(part)?.[1]?.toLowerCase();
      const closing = part.startsWith("</");
      if (tag === "pre") pre += closing ? -1 : 1;
      else if (tag === "button") button += closing ? -1 : 1;
      else if (tag === "a") {
        anchor += closing ? -1 : 1;
        if (!closing && visit.link) {
          const href = attrOf(part, "href");
          const loc = isLocalHref(href) ? codeSpanPath(href) : null;
          const next = loc && visit.link(part, loc);
          if (next) { out += next; continue; }
        }
      } else if (tag === "code") {
        if (!closing && !pre && !anchor && !button && parts[i + 2] === "</code>") {
          const inner = parts[i + 1];
          const loc = codeSpanPath(decodeHtml(inner));
          const next = loc && visit.code?.(part + inner + parts[i + 2], loc);
          if (next) { out += next; i += 2; continue; }
        }
        code += closing ? -1 : 1;
      }
      out += part;
      continue;
    }
    if (pre || code || anchor || button || !part || !visit.text) { out += part; continue; }
    const text = decodeHtml(part);
    const cands = findPathCandidates(text);
    const next = cands.length ? visit.text(text, cands) : null;
    out += next ?? part;
  }
  return out;
}

// Every path the prose names, as written: [{ path, line?, column?, endLine?, from }]
// with from = "code" | "text" | "link". `plainText: false` skips prose text.
export function collectPathRefs(html, { plainText = true, limit = 40 } = {}) {
  if (!html) return [];
  const seen = new Set();
  const refs = [];
  const add = (loc, from) => {
    if (refs.length >= limit || seen.has(loc.path)) return;
    seen.add(loc.path);
    refs.push({ ...loc, from });
  };
  walkProse(html, {
    code: (_, loc) => { add(loc, "code"); return null; },
    link: (_, loc) => { add(loc, "link"); return null; },
    text: plainText ? (_, cands) => { for (const { index: _i, length: _l, ...loc } of cands) add(loc, "text"); return null; } : null,
  });
  return refs;
}

// The prose with each path that exists drawn as a chip (a link keeps its text
// and gains the glyph); a rooted path in code that does not exist is marked
// missing. `lookup(pathAsWritten)` → { abs, type } | { abs, missing: true } | null.
export function withPathChips(html, lookup, { cwd, shorten = true, title = false, plainText = true } = {}) {
  if (!html) return html;
  const chip = (loc, hit) => pathChipHtml({ ...loc, ...hit, written: loc.path }, { cwd, shorten, title });
  return walkProse(html, {
    code: (span, loc) => {
      const hit = lookup(loc.path);
      if (!hit) return null;
      if (hit.missing) return isRootedPath(loc.path) ? span.replace("<code", '<code class="path-missing" title="Not found"') : null;
      return chip(loc, hit);
    },
    link: (tag, loc) => {
      const hit = lookup(loc.path);
      if (!hit || hit.missing) return null;
      const attrs = pathDataAttrs({ ...loc, ...hit });
      return tag.replace(/^<a\b/, `<a class="path-link"${attrs}`) + glyphSvg({ type: hit.type, name: loc.path }, { className: "path-link-icon" });
    },
    text: plainText
      ? (text, cands) => {
        let out = "";
        let at = 0;
        for (const c of cands) {
          const hit = lookup(c.path);
          if (!hit || hit.missing) continue;
          out += escapeHtml(text.slice(at, c.index)) + chip(c, hit);
          at = c.index + c.length;
        }
        return at === 0 ? null : out + escapeHtml(text.slice(at));
      }
      : null,
  });
}
