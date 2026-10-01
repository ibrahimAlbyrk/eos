// Message ids + replies — what the model reads (pure domain).
//
//   inbound operator turn → `<msg id="14"/>` line above the body
//   inbound agent/system  → `id="14"` attribute on its sender wrapper
//   assistant text block  → "14.1", "14.2" … daemon-side only (TextBlock.msgId)
//   reply                 → `<reply_to …>` line above the operator's body
//
// The model sees inbound ids but never its own: it would have to write them
// itself. So a reply to an inbound message is the bare id, a reply to an
// assistant message carries a short excerpt the model matches against its own
// words, and a target outside the live context (compacted / cleared) carries its
// full text, because the model can no longer see it at all.

import { AgentEventSchema } from "../../../contracts/src/canonical.ts";
import type { AgentEvent, ContentBlock } from "../../../contracts/src/canonical.ts";
import type { ReplyRef, WorkerEventRow } from "../../../contracts/src/events.ts";
import { escapeTagBody } from "./sender-tag.ts";

const EXCERPT_CHARS = 160;
const WHOLE_UP_TO_CHARS = 280;
const FULL_TEXT_CAP_CHARS = 4000;

export interface ReplyTarget {
  rowId: number;
  msgId?: string;
  role: ReplyRef["role"];
  text: string;
}

// A leading slash command must stay the very first token — the agent's own
// command parser (claude expands `.md` commands natively) only looks there — so
// such a turn takes no id head.
export function startsWithSlashCommand(text: string): boolean {
  return /^\/\S/.test(text);
}

// Head of an operator turn: the id marker, then the reply block (if any).
export function prefixOperatorTurn(body: string, msgId: number | undefined, replyBlock: string | undefined): string {
  const head = [msgId != null ? `<msg id="${msgId}"/>` : "", replyBlock ?? ""].filter(Boolean);
  return head.length > 0 ? `${head.join("\n")}\n${body}` : body;
}

// Removes the head prefixOperatorTurn added — for code that reads an operator
// turn back out of the agent's transcript (rewind) and must see what was typed.
const TURN_HEAD = /^(?:<msg id="\d+"\/>\n)?(?:<reply_to\b[^>]*\/>\n|<reply_to\b[^>]*>[\s\S]*?<\/reply_to>\n)?/;

export function stripTurnHead(text: string): string {
  return text.replace(TURN_HEAD, "");
}

export function excerpt(text: string, max = EXCERPT_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
}

export function buildReplyBlock(target: ReplyTarget, inContext: boolean): string {
  const idAttr = target.msgId ? ` id="${target.msgId}"` : "";
  if (inContext && target.msgId && target.role !== "assistant") return `<reply_to${idAttr}/>`;
  const body = !inContext
    ? (target.text.length <= FULL_TEXT_CAP_CHARS ? target.text : `${target.text.slice(0, FULL_TEXT_CAP_CHARS)}…`)
    : (target.text.length <= WHOLE_UP_TO_CHARS ? target.text : excerpt(target.text));
  return `<reply_to${idAttr}>${escapeTagBody(body)}</reply_to>`;
}

// The display snapshot stored on the replying user_message row.
export function replyRefOf(target: ReplyTarget): ReplyRef {
  return {
    rowId: target.rowId,
    ...(target.msgId ? { msgId: target.msgId } : {}),
    role: target.role,
    excerpt: excerpt(target.text),
  };
}

function hasText(block: ContentBlock): block is Extract<ContentBlock, { type: "text" }> {
  return block.type === "text" && block.text.trim() !== "";
}

// Gives each non-empty assistant text block its id; every other event passes through.
export function stampAssistantMsgIds(event: AgentEvent, nextId: () => string): AgentEvent {
  if (event.type !== "message" || event.role !== "assistant" || !event.blocks.some(hasText)) return event;
  return { ...event, blocks: event.blocks.map((b) => (hasText(b) ? { ...b, msgId: nextId() } : b)) };
}

function parsePayload(payload: string | null): Record<string, unknown> | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function target(rowId: number, role: ReplyTarget["role"], text: unknown, msgId: unknown): ReplyTarget | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  return { rowId, role, text, ...(typeof msgId === "string" ? { msgId } : {}) };
}

function assistantTarget(rowId: number, payload: Record<string, unknown>): ReplyTarget | null {
  const parsed = AgentEventSchema.safeParse(payload);
  if (!parsed.success) return null;
  const event = parsed.data;
  if (event.type !== "message" || event.role !== "assistant") return null;
  const blocks = event.blocks.filter(hasText);
  return target(rowId, "assistant", blocks.map((b) => b.text).join("\n"), blocks.find((b) => b.msgId)?.msgId);
}

// The chat message an event row holds, or null when the row is not one.
export function replyTargetFromRow(row: WorkerEventRow): ReplyTarget | null {
  const p = parsePayload(row.payload);
  if (!p) return null;
  switch (row.type) {
    case "user_message":
      return target(row.id, "user", p.text, p.msgId);
    case "orchestrator_message":
    case "worker_report":
    case "peer_request":
      return target(row.id, "agent", p.text, p.msgId);
    case "loop_continuation":
    case "report_reminder":
    case "permission_ask":
      return target(row.id, "system", p.text, p.msgId);
    case "agent_event":
      return assistantTarget(row.id, p);
    default:
      return null;
  }
}
