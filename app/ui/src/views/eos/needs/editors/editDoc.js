// Editing a draft's ResultDoc (03 §4.3, 08 §4.9), with no React in it. The
// edited doc is always a whole ResultDoc: changed parts carry their new
// text, removed parts are left out. The dashboard never sends a diff.

export const partOf = (doc, key) => doc?.parts.find((p) => p.key === key);
export const partsOf = (doc, prefix) => doc.parts.filter((p) => p.key.startsWith(prefix));

// The doc with one part's text (and meta, when given) replaced.
export function withText(doc, key, text, meta) {
  return { ...doc, parts: doc.parts.map((p) => (p.key === key ? { ...p, text, ...(meta ? { meta } : {}) } : p)) };
}

// The doc with `key` included or left out; an included part comes back as
// the original had it, in the original's order.
export function withPart(doc, original, key, included) {
  if (!included) return { ...doc, parts: doc.parts.filter((p) => p.key !== key) };
  if (partOf(doc, key)) return doc;
  const kept = new Map(doc.parts.map((p) => [p.key, p]));
  kept.set(key, partOf(original, key));
  const ordered = original.parts.filter((p) => kept.has(p.key)).map((p) => kept.get(p.key));
  const added = doc.parts.filter((p) => !partOf(original, p.key));
  return { ...doc, parts: [...ordered, ...added] };
}

const sameMeta = (a = {}, b = {}) => JSON.stringify(a) === JSON.stringify(b);

// Whether one part differs from the original's: its text, or its meta.
export function partChanged(doc, original, key) {
  const now = partOf(doc, key);
  const was = partOf(original, key);
  if (!now || !was) return Boolean(now) !== Boolean(was);
  return now.text !== was.text || !sameMeta(now.meta, was.meta);
}

export function docChanged(doc, original) {
  if (!doc) return false;
  const keys = new Set([...doc.parts, ...original.parts].map((p) => p.key));
  return [...keys].some((key) => partChanged(doc, original, key));
}

// A line comment's suggested code rides in its text as GitHub's
// ```suggestion block; the editor gives it its own field.
const SUGGESTION = /\n{1,2}```suggestion\n([\s\S]*?)\n?```\s*$/;

export function splitSuggestion(text) {
  const m = SUGGESTION.exec(text);
  return m ? { body: text.slice(0, m.index), code: m[1] } : { body: text, code: null };
}

export function joinSuggestion(body, code) {
  return code == null || code === "" ? body : `${body}\n\n\`\`\`suggestion\n${code}\n\`\`\``;
}

// A mail's body as one text: its paragraphs with a blank line between.
export const mailBody = (doc) => partsOf(doc, "p:").map((p) => p.text).join("\n\n");

// The mail with its body split back into paragraphs `p:1`…`p:n`.
export function withMailBody(doc, text) {
  const paragraphs = text.split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean);
  const first = partsOf(doc, "p:")[0];
  const role = first?.role ?? "paragraph";
  const parts = paragraphs.map((t, i) => ({ ...(partOf(doc, `p:${i + 1}`) ?? { role }), key: `p:${i + 1}`, text: t }));
  const at = doc.parts.findIndex((p) => p.key.startsWith("p:"));
  const rest = doc.parts.filter((p) => !p.key.startsWith("p:"));
  const place = at < 0 ? rest.length : doc.parts.slice(0, at).filter((p) => !p.key.startsWith("p:")).length;
  return { ...doc, parts: [...rest.slice(0, place), ...parts, ...rest.slice(place)] };
}

const NOUNS = { "github.review": "review", mail: "mail", "slack.message": "message", "slack.reply": "reply" };

// What Send says for the draft as it is: "Send" untouched, "Send edited
// review" once changed, "Send review with 2 of 3 comments" when comments
// were left out.
export function sendLabel(original, doc) {
  if (!original || !docChanged(doc, original)) return "Send";
  const noun = NOUNS[original.kind] ?? "draft";
  if (original.kind === "github.review") {
    const total = partsOf(original, "c:").length;
    const kept = partsOf(doc, "c:").length;
    if (kept < total) return `Send review with ${kept} of ${total} comment${total === 1 ? "" : "s"}`;
  }
  return `Send edited ${noun}`;
}
