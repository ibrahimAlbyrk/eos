import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// github-dark-dimmed palette — matches the hljs theme used elsewhere in the app
const style = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: "#f47067" },
  { tag: [t.string, t.special(t.string), t.regexp, t.escape], color: "#96d0ff" },
  { tag: t.comment, color: "#768390" },
  { tag: [t.number, t.bool, t.atom, t.literal, t.null], color: "#6cb6ff" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "#dcbdfb" },
  { tag: [t.typeName, t.className, t.namespace, t.self, t.standard(t.variableName)], color: "#f69d50" },
  { tag: [t.definition(t.variableName), t.attributeName, t.propertyName, t.labelName], color: "#6cb6ff" },
  { tag: t.variableName, color: "#adbac7" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "#adbac7" },
  { tag: t.tagName, color: "#8ddb8c" },
  { tag: [t.meta, t.processingInstruction], color: "#768390" },
  { tag: t.heading, color: "#316dca", fontWeight: "600" },
  { tag: [t.link, t.url], color: "#96d0ff", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.inserted, color: "#b4f1b4", backgroundColor: "rgba(70, 149, 74, 0.18)" },
  { tag: t.deleted, color: "#ffd8d3", backgroundColor: "rgba(229, 83, 75, 0.18)" },
  { tag: t.invalid, color: "#ff938a" },
]);

export const fvSyntaxHighlight = syntaxHighlighting(style);
