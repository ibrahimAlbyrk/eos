// turnIndex — splits transcript blocks into conversation turns for the turn
// rail. A turn opens at a prompt (the user's message, or a parent's directive
// for a worker) and runs until the next prompt; its preview is the LAST
// assistant text in the span — intermediate "let me check…" lines are noise,
// the final answer is what the reader is looking for.

import { parseAttachmentMessage } from "./attachmentTokens.js";

const TURN_KINDS = new Set(["user", "directive"]);

export function deriveTurns(blocks, keyOf) {
  const turns = [];
  let cur = null;
  blocks.forEach((b, i) => {
    if (TURN_KINDS.has(b.kind)) {
      cur = { key: keyOf(b, i), title: promptTitle(b.text), preview: "", tools: 0, startTs: b.ts, endTs: b.ts };
      turns.push(cur);
      return;
    }
    if (!cur) return;
    if (b.ts != null) cur.endTs = b.ts;
    if (b.kind === "assistant" && b.text?.trim()) cur.preview = plainPreview(b.text);
    else if (b.kind === "toolGroup") cur.tools += b.tools.length;
    else if (b.kind === "tool" || b.kind === "agentRun") cur.tools += 1;
  });
  return turns;
}

function promptTitle(text) {
  const { display, attachments } = parseAttachmentMessage(text);
  const line = display.replace(/\s+/g, " ").trim();
  if (line) return line;
  const n = attachments.length;
  return n ? `${n} attachment${n === 1 ? "" : "s"}` : "(empty message)";
}

// Markdown → one flat line. `**bold**` survives on purpose: the card renders it.
export function plainPreview(md) {
  return md
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
