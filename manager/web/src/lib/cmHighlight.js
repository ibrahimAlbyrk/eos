import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// Palette lives in styles.css --hl-* tokens (github-dark-dimmed / github-light
// per theme). HighlightStyle emits CSS, so var() passes through verbatim.
const style = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--hl-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.escape], color: "var(--hl-string)" },
  { tag: t.comment, color: "var(--hl-comment)" },
  { tag: [t.number, t.bool, t.atom, t.literal, t.null], color: "var(--hl-number)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--hl-func)" },
  { tag: [t.typeName, t.className, t.namespace, t.self, t.standard(t.variableName)], color: "var(--hl-type)" },
  { tag: [t.definition(t.variableName), t.attributeName, t.propertyName, t.labelName], color: "var(--hl-number)" },
  { tag: t.variableName, color: "var(--hl-fg)" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--hl-fg)" },
  { tag: t.tagName, color: "var(--hl-tag)" },
  { tag: [t.meta, t.processingInstruction], color: "var(--hl-comment)" },
  { tag: t.heading, color: "var(--hl-heading)", fontWeight: "600" },
  { tag: [t.link, t.url], color: "var(--hl-string)", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.inserted, color: "var(--hl-ins-fg)", backgroundColor: "var(--hl-ins-bg)" },
  { tag: t.deleted, color: "var(--hl-del-fg)", backgroundColor: "var(--hl-del-bg)" },
  { tag: t.invalid, color: "var(--hl-invalid)" },
]);

export const fvSyntaxHighlight = syntaxHighlighting(style);
