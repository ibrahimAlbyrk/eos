// turnIndex — splits transcript blocks into conversation turns for the turn
// rail. A turn opens at a prompt (the user's message, or a parent's directive
// for a worker) and runs until the next prompt; its preview is the LAST
// assistant text in the span — intermediate "let me check…" lines are noise,
// the final answer is what the reader is looking for.
// `boot` seeds the first turn for a prompt that has no block (a dispatched
// worker's task, rendered as a card from worker.prompt): { key, text, ts }.

import { parseAttachmentMessage } from "./attachmentTokens.js";

const TURN_KINDS = new Set(["user", "directive"]);

export function deriveTurns(blocks, keyOf, boot = null) {
  const turns = [];
  let cur = null;
  if (boot) {
    cur = openTurn(boot.key, boot.text, boot.ts);
    turns.push(cur);
  }
  blocks.forEach((b, i) => {
    if (TURN_KINDS.has(b.kind)) {
      cur = openTurn(keyOf(b, i), b.text, b.ts);
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

function openTurn(key, text, ts) {
  return { key, title: promptTitle(text), preview: "", tools: 0, startTs: ts, endTs: ts };
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

// The window holds only the newest pages, so its turns are a suffix of the
// conversation. Prepend every whole-conversation turn that starts before the
// window's first one (title-only — no preview or tool count) to index it all.
export function withOlderTurns(allTurns, windowTurns) {
  const firstTs = windowTurns[0]?.startTs ?? Infinity;
  const older = allTurns.filter((t) => t.startTs < firstTs);
  return older.length ? [...older, ...windowTurns] : windowTurns;
}
