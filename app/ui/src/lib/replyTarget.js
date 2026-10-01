// Which transcript blocks can be replied to, and the reply target each one
// becomes. Only a block backed by a durable event row (rowId) qualifies — the
// daemon resolves the reply from that row, so an optimistic or still-streaming
// block has nothing to point at yet.
const ROLE_BY_KIND = {
  user: "user",
  assistant: "assistant",
  report: "agent",
  directive: "agent",
  "peer-request": "agent",
  loop: "system",
};

export function replyTargetOf(block) {
  const role = ROLE_BY_KIND[block?.kind];
  if (!role || block.optimistic || !block.rowId) return null;
  return { rowId: block.rowId, role, text: block.text ?? "", ts: block.ts ?? null };
}
