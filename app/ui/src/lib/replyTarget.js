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
};

export function replyTargetOf(block) {
  const role = ROLE_BY_KIND[block?.kind];
  if (!role || block.optimistic || !block.rowId) return null;
  return { rowId: block.rowId, role, text: block.text ?? "", ts: block.ts ?? null };
}

// A reply to one passage of the message: the target, narrowed to what the
// user selected in it.
export function withSelection(target, selection) {
  return selection ? { ...target, selection } : target;
}

// The passage the user selected inside `root`, when the pointer (x, y) is on
// it: a right-click on the selection acts on the selection, one anywhere else
// on the whole message. `selection` is the window's (window.getSelection()).
export function selectedPassage(selection, root, x, y) {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const onIt = [...range.getClientRects()].some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  return (onIt && selection.toString().trim()) || null;
}
