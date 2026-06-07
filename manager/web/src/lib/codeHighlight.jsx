// Standalone syntax highlighting for code fragments outside CodeMirror
// (diff hunks etc). Reuses the same Lezer parsers as the FileViewer editor
// (cmLang.js) and the same --hl-* palette, but emits plain spans so callers
// can render line-by-line.

import { highlightCode, tagHighlighter, tags as t } from "@lezer/highlight";
import { cmLanguageFor } from "./cmLang.js";

// Mirrors lib/cmHighlight.js tag grouping; classes styled in styles.css.
const highlighter = tagHighlighter([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], class: "hlc-keyword" },
  { tag: [t.string, t.special(t.string), t.regexp, t.escape], class: "hlc-string" },
  { tag: t.comment, class: "hlc-comment" },
  { tag: [t.number, t.bool, t.atom, t.literal, t.null], class: "hlc-number" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], class: "hlc-func" },
  { tag: [t.typeName, t.className, t.namespace, t.self, t.standard(t.variableName)], class: "hlc-type" },
  { tag: [t.definition(t.variableName), t.attributeName, t.propertyName, t.labelName], class: "hlc-number" },
  { tag: t.tagName, class: "hlc-tag" },
  { tag: [t.meta, t.processingInstruction], class: "hlc-comment" },
  { tag: t.heading, class: "hlc-heading" },
  { tag: [t.link, t.url], class: "hlc-link" },
  { tag: t.invalid, class: "hlc-invalid" },
]);

// Language instances are stateless — cache one parser per extension instead
// of rebuilding a LanguageSupport for every hunk.
const parserCache = new Map();
function parserFor(filePath) {
  const name = filePath.split("/").pop().toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop() : name;
  if (!parserCache.has(ext)) {
    parserCache.set(ext, cmLanguageFor(filePath)?.language?.parser ?? null);
  }
  return parserCache.get(ext);
}

// Highlights a multi-line block once and returns one React-node array per
// line, or null when the language is unknown (caller falls back to raw text).
export function highlightToLines(code, filePath) {
  if (!code || !filePath) return null;
  const parser = parserFor(filePath);
  if (!parser) return null;
  let tree;
  try {
    tree = parser.parse(code);
  } catch {
    return null;
  }
  const lines = [];
  let cur = [];
  let key = 0;
  highlightCode(
    code, tree, highlighter,
    (text, classes) => {
      cur.push(classes ? <span key={key++} className={classes}>{text}</span> : text);
    },
    () => { lines.push(cur); cur = []; },
  );
  lines.push(cur);
  return lines;
}
