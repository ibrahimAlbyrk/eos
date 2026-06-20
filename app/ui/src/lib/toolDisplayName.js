// Humanize a tool name for display in the chat. MCP tools arrive as
// "mcp__<server>__<action>" — render them "<server> · <action>" with the
// action's underscores shown as spaces (query-docs stays, send_message_to_parent
// reads as words). Non-MCP names (Read, TodoWrite, …) pass through unchanged.
export function toolDisplayName(name) {
  const n = String(name ?? "");
  const m = /^mcp__(.+?)__(.+)$/.exec(n);
  if (!m) return n;
  return `${m[1]} · ${m[2].replace(/_/g, " ")}`;
}
