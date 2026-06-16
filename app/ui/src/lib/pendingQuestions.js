import { parsePayload } from "./messageParser.js";

// Derive the still-open AskUserQuestion banners straight from the daemon's
// authoritative question_pending / question_answered events (NOT tool_running
// minus tool_done — a stray PostToolUse tool_done used to close the banner
// prematurely). Returns one entry per currently-pending toolUseId, in the
// order the questions first appeared.
export function derivePendingQuestions(events) {
  const open = new Map();
  for (const ev of events) {
    if (ev.type === "question_pending") {
      const p = parsePayload(ev.payload);
      if (p.toolUseId && Array.isArray(p.questions) && p.questions.length > 0) {
        open.set(p.toolUseId, { toolUseId: p.toolUseId, questions: p.questions });
      }
    }
    if (ev.type === "question_answered") {
      const p = parsePayload(ev.payload);
      if (p.toolUseId) open.delete(p.toolUseId);
    }
  }
  return [...open.values()];
}
