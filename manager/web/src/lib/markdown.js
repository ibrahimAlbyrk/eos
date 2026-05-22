// Markdown → safe HTML for agent-rendered prose.
//
// marked does NOT sanitize raw HTML in source — a <script>/<img onerror> the
// model echoes (e.g. summarising a malicious WebFetch page) would otherwise
// execute against the daemon-served origin. We run the output through
// DOMPurify before handing it to dangerouslySetInnerHTML.

import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import python from "highlight.js/lib/languages/python";
import yaml from "highlight.js/lib/languages/yaml";
import diff from "highlight.js/lib/languages/diff";
import sql from "highlight.js/lib/languages/sql";
import markdown from "highlight.js/lib/languages/markdown";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";

// Register a focused set of common languages. Anything outside this list
// falls back to auto-detection, which is good enough for unfamiliar snippets
// but ~3× slower; keep the registered set tight.
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("python", python);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);

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
  if (resolved && hljs.getLanguage(resolved)) {
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
    // Untagged fenced block, or an unfamiliar lang name. Auto-detect against
    // the registered set (13 langs) — false positives are bounded by what we
    // chose to register, no kotlin-as-java surprises.
    try {
      const auto = hljs.highlightAuto(text);
      highlighted = auto.value;
      appliedLang = auto.language || "";
    } catch {
      highlighted = escapeHtml(text);
    }
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
