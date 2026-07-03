// Turn the raw event rows behind GET /workers/:id/events into a compact,
// lane-neutral message transcript for get_worker_messages. The two Claude lanes
// store assistant turns differently (canonical `agent_event` vs legacy CLI
// `jsonl`) and the timeline is dense with non-message rows (tool calls, usage,
// heartbeats, state), so N rows are never N messages — the caller over-fetches
// and this drops everything that is not a conversation message.

import { AgentEventSchema } from "../../../contracts/src/canonical.ts";
import type { WorkerEventRow } from "../../../contracts/src/events.ts";

export type MessageRole = "assistant" | "user" | "orchestrator" | "worker" | "peer";

export interface NormalizedMessage {
  ts: number;
  role: MessageRole;
  text: string;
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

function message(ts: number, role: MessageRole, text: unknown): NormalizedMessage | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  return { ts, role, text };
}

// agent_event rows carry the full AgentEvent — only an assistant `message` with
// text blocks is a conversation message; tool_call / tool_result-only messages
// (and every non-message event) are noise. Reasoning blocks are excluded from
// the joined text.
function assistantFromAgentEvent(ts: number, payload: Record<string, unknown>): NormalizedMessage | null {
  const parsed = AgentEventSchema.safeParse(payload);
  if (!parsed.success) return null;
  const event = parsed.data;
  if (event.type !== "message" || event.role !== "assistant") return null;
  const text = event.blocks
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .filter((t) => t.trim() !== "")
    .join("\n");
  return message(ts, "assistant", text);
}

function rowToMessage(row: WorkerEventRow): NormalizedMessage | null {
  const payload = parsePayload(row.payload);
  if (!payload) return null;
  switch (row.type) {
    case "agent_event":
      return assistantFromAgentEvent(row.ts, payload);
    // Legacy CLI lane: only assistant_text is a message; thinking / tool_use /
    // tool_result (and user_text / skill_body, which the daemon covers via the
    // synthesized inbound rows below) are skipped.
    case "jsonl":
      return payload.kind === "assistant_text" ? message(row.ts, "assistant", payload.text) : null;
    case "user_message":
      return message(row.ts, "user", payload.text);
    case "orchestrator_message":
      return message(row.ts, "orchestrator", payload.text);
    case "worker_report":
      return message(row.ts, "worker", payload.text);
    case "peer_request":
      return message(row.ts, "peer", payload.text);
    default:
      return null;
  }
}

// `rows` arrive in chronological (oldest→newest) reading order — the shape
// GET /workers/:id/events?order=desc returns (newest-N, re-sorted ascending).
// Returns the newest `n` messages, still oldest→newest; fewer if the window held
// fewer than `n`.
export function normalizeEventRows(rows: WorkerEventRow[], n: number): NormalizedMessage[] {
  const take = Math.floor(n);
  if (take <= 0) return [];
  const messages: NormalizedMessage[] = [];
  for (const row of rows) {
    const m = rowToMessage(row);
    if (m) messages.push(m);
  }
  return messages.length > take ? messages.slice(messages.length - take) : messages;
}
