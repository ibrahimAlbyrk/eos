// Message reactions: the emoji the picker offers, which chats take them, and
// the agent's two reaction tools as the transcript reads them.

import { rowPayload } from "./toolLifecycle.js";

export const QUICK_EMOJI = ["👍", "👎", "👌", "❤️", "🤔", "👀"];

// The "+" grid: seven to a row, like the quick row above it.
export const MORE_EMOJI = [
  "😀", "😂", "🥲", "😊", "😍", "🤩", "😎",
  "😅", "😬", "😴", "😢", "😡", "🤯", "🥳",
  "🙏", "👏", "🙌", "💪", "🤝", "👋", "🤷",
  "😉", "🙈", "🔥", "✨", "🎉", "🚀", "💯",
  "✅", "❌", "⚠️", "❓", "❗", "💡", "📌",
  "⭐", "🏆", "🧠", "🐛", "🔧", "📝", "⏳",
];

// The chats the user talks to directly: a focused chat or an orchestrator.
export function isReactableChat(worker) {
  return Boolean(worker) && (worker.is_orchestrator === true || worker.agent_role === "focused");
}

const TOOL_RE = /^mcp__(?:worker|orchestrator)__(react|no_reply)$/;

// "react" (the agent's emoji on a message), "no_reply" (it chose to say
// nothing), or null for any other tool.
export function reactionToolKind(name) {
  return TOOL_RE.exec(name ?? "")?.[1] ?? null;
}

export const isReactionTool = (name) => reactionToolKind(name) !== null;

// Whether the newest turn in `rows` (oldest first) ended with the agent choosing
// not to reply: the last thing it did was call no_reply.
export function endedWithNoReply(rows) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].type !== "agent_event") continue;
    const e = rowPayload(rows[i]);
    if (e?.type !== "message" || e.role !== "assistant") continue;
    const last = (e.blocks ?? []).findLast((b) => b.type === "tool_call" || (b.type === "text" && b.text?.trim()));
    return last?.type === "tool_call" && reactionToolKind(last.name) === "no_reply";
  }
  return false;
}
