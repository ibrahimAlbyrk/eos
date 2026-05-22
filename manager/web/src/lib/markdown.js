// Markdown → safe HTML for agent-rendered prose.
//
// marked does NOT sanitize raw HTML in source — a <script>/<img onerror> the
// model echoes (e.g. summarising a malicious WebFetch page) would otherwise
// execute against the daemon-served origin. We run the output through
// DOMPurify before handing it to dangerouslySetInnerHTML.

import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";

// Lazy registration: language packs ship in separate chunks and load on first
// encounter. Cuts initial bundle by ~80KB minified; the first code block in a
// language pays a small async cost (one network round-trip in dev, otherwise
// hits the cached chunk) and re-renders once registered.
const LANG_LOADERS = {
  javascript: () => import("highlight.js/lib/languages/javascript"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  bash:       () => import("highlight.js/lib/languages/bash"),
  json:       () => import("highlight.js/lib/languages/json"),
  css:        () => import("highlight.js/lib/languages/css"),
  xml:        () => import("highlight.js/lib/languages/xml"),
  python:     () => import("highlight.js/lib/languages/python"),
  yaml:       () => import("highlight.js/lib/languages/yaml"),
  diff:       () => import("highlight.js/lib/languages/diff"),
  sql:        () => import("highlight.js/lib/languages/sql"),
  markdown:   () => import("highlight.js/lib/languages/markdown"),
  go:         () => import("highlight.js/lib/languages/go"),
  rust:       () => import("highlight.js/lib/languages/rust"),
};

const LANG_STATE = new Map(); // name -> "loading" | "ready" | "failed"
const RERENDER_SUBSCRIBERS = new Set();

function notifyLanguageReady() {
  for (const cb of RERENDER_SUBSCRIBERS) {
    try { cb(); } catch {}
  }
}

export function onLanguageReady(cb) {
  RERENDER_SUBSCRIBERS.add(cb);
  return () => RERENDER_SUBSCRIBERS.delete(cb);
}

function ensureLanguage(name) {
  if (!name || !LANG_LOADERS[name]) return false;
  if (hljs.getLanguage(name)) return true;
  const state = LANG_STATE.get(name);
  if (state === "loading" || state === "failed") return false;
  LANG_STATE.set(name, "loading");
  LANG_LOADERS[name]()
    .then((mod) => {
      hljs.registerLanguage(name, mod.default);
      LANG_STATE.set(name, "ready");
      notifyLanguageReady();
    })
    .catch(() => { LANG_STATE.set(name, "failed"); });
  return false;
}

// Aliases users commonly write in fenced code blocks.
const LANG_ALIAS = {
  js: "javascript",
  ts: "typescript",
  jsx: "javascript",
  tsx: "typescript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  yml: "yaml",
  html: "xml",
  svg: "xml",
  py: "python",
  md: "markdown",
  rs: "rust",
  golang: "go",
};

marked.use({
  // GFM = tables, strikethrough, autolinks, task lists. Standard nowadays.
  gfm: true,
  // breaks=true turns single newlines into <br>. Claude's prose usually has
  // blank-line paragraph separators, so this matches its formatting intent.
  breaks: true,
});

const renderer = new marked.Renderer();

// Open external links in a new tab with rel=noopener so a malicious URL
// can't reach the daemon-served origin.
const originalLink = renderer.link.bind(renderer);
renderer.link = function (...args) {
  const html = originalLink(...args);
  if (html.startsWith("<a ")) {
    return html.replace(/^<a /, '<a target="_blank" rel="noopener noreferrer" ');
  }
  return html;
};

// Syntax-highlight fenced code blocks. We never embed user-controlled HTML in
// the highlighted output: hljs already escapes the raw source, and the only
// `lang` value we interpolate goes through className where it's harmless.
renderer.code = function ({ text, lang }) {
  const langKey = (lang || "").trim().toLowerCase();
  const resolved = LANG_ALIAS[langKey] || langKey;
  let highlighted;
  let appliedLang = "";
  const ready = resolved ? ensureLanguage(resolved) : false;
  if (ready && hljs.getLanguage(resolved)) {
    try {
      highlighted = hljs.highlight(text, { language: resolved, ignoreIllegals: true }).value;
      appliedLang = resolved;
    } catch {
      highlighted = escapeHtml(text);
    }
  } else if (resolved === "text" || resolved === "plain" || resolved === "txt") {
    // Explicit "no highlighting please" — skip hljs entirely so logs / prose
    // pasted as code don't get false-positive keyword colors.
    highlighted = escapeHtml(text);
  } else {
    // Either no lang specified or its pack hasn't loaded yet. Render escaped
    // text for now; once the loader resolves, subscribers re-render and the
    // highlight appears.
    highlighted = escapeHtml(text);
  }
  const cls = appliedLang ? `hljs language-${appliedLang}` : "hljs";
  return `<pre><code class="${cls}">${highlighted}</code></pre>\n`;
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;"
    : c === "<" ? "&lt;"
    : c === ">" ? "&gt;"
    : c === '"' ? "&quot;"
    : "&#39;"
  );
}

marked.use({ renderer });

/**
 * Render markdown text into HTML. Returns an empty string for empty input
 * and falls back to the raw text inside <p> if parsing throws — the UI never
 * crashes because the model wrote a broken table.
 */
const SANITIZE_CONFIG = {
  ADD_ATTR: ["target", "rel"],
  FORBID_TAGS: ["style", "iframe", "object", "embed", "form"],
  FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus"],
};

export function renderMarkdown(text) {
  if (!text) return "";
  try {
    const raw = marked.parse(String(text));
    return DOMPurify.sanitize(raw, SANITIZE_CONFIG);
  } catch {
    return `<p>${escapeHtml(text)}</p>`;
  }
}
