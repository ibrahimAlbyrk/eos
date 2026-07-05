// Pure link resolution for the markdown preview. Authored markdown hrefs are
// relative to the file being viewed, but WKWebView resolves them against the
// eos://app/ base — so we re-resolve the RAW authored href against the open
// file's real on-disk directory here, then classify what it points at.
// No React, no I/O — string math only, unit-tested.

import { parentDir } from "./explorerApi.js";
import { isMarkdownPath } from "./markdownPreview.js";

// fragment — an in-doc #anchor; external — a scheme (http/https/mailto/…) or a
// protocol-relative //host, which must open in the OS browser; relative — a
// filesystem path that resolveRelativePath turns absolute.
export function classifyHref(href) {
  const h = String(href ?? "").trim();
  if (h.startsWith("#")) return "fragment";
  if (!h) return "external";
  if (h.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(h)) return "external";
  return "relative";
}

function stripQueryAndFragment(href) {
  const cut = href.search(/[?#]/);
  return cut === -1 ? href : href.slice(0, cut);
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// Collapse "." and ".." segments POSIX-style; ".." can never climb above root.
function normalizeSegments(path) {
  const out = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { out.pop(); continue; }
    out.push(seg);
  }
  return "/" + out.join("/");
}

// Resolve a raw authored href against the absolute path of the file it appears
// in. Query and fragment are dropped, percent-escapes decoded, "."/".." folded.
// An href that is already absolute (leading "/") ignores the from-file dir.
export function resolveRelativePath(fromFileAbs, href) {
  const path = safeDecode(stripQueryAndFragment(String(href ?? "")));
  const base = path.startsWith("/") ? "" : parentDir(fromFileAbs);
  return normalizeSegments(`${base}/${path}`);
}

// The pure decision for a clicked markdown-preview link, given the file it lives
// in and the RAW authored href. Keeps the DOM hook thin and makes the
// relative-.md / fragment branches unit-testable without a browser:
//   "open-md"  → open the resolved sibling .md in-preview (preventDefault)
//   "fragment" → scroll to an in-doc anchor (preventDefault)
//   "ignore"   → external link or non-.md relative link — let the click bubble
export function decideLinkAction(fromFileAbs, href) {
  const kind = classifyHref(href);
  if (kind === "fragment") return { action: "fragment" };
  if (kind === "relative") {
    const path = resolveRelativePath(fromFileAbs, href);
    if (isMarkdownPath(path)) return { action: "open-md", path };
  }
  return { action: "ignore" };
}
