// Caller-scope guard — which MCP servers are Eos control plane. Their tools
// mutate orchestration state (spawn/kill/message/report), so only the main
// agent loop may call them; subagent calls (hook input carries agent_id) are
// denied. Lives in contracts because both core (PolicyGatewayService step 0)
// and spawner (PreToolUse hook response — the only gate under native
// bypassPermissions, where PermissionRequest never fires) enforce it.
// Names must match the builtins keys in manager/container.ts buildMcpBuiltins.

export const EOS_BUILTIN_MCP_SERVERS = ["orchestrator", "worker", "gateway"] as const;

export type EosBuiltinMcpServer = (typeof EOS_BUILTIN_MCP_SERVERS)[number];

export function isEosControlTool(toolName: string): boolean {
  return EOS_BUILTIN_MCP_SERVERS.some((server) => toolName.startsWith(`mcp__${server}__`));
}

// Built-in tools with no usable surface in Eos. AskUserQuestion's native TUI
// menu has no reliable answer channel here — the operator answers through the
// dashboard, which the orchestrator reaches via mcp__orchestrator__ask_user
// instead. Enforced at every layer that can fire: auto-allow.sh
// (PermissionRequest), spawner PreToolUse (the only gate under native
// bypassPermissions), and PolicyGatewayService step 0 (ahead of user rules).
export const BLOCKED_BUILTIN_TOOLS = ["AskUserQuestion"] as const;

export const BLOCKED_BUILTIN_TOOL_MESSAGE =
  "AskUserQuestion is disabled in Eos — its native menu has no answer surface here. " +
  "Orchestrator: ask the operator via mcp__orchestrator__ask_user. " +
  "Worker: proceed on your best judgment or report `needs input: <ask>` to your parent.";

export function isBlockedBuiltinTool(toolName: string): boolean {
  return (BLOCKED_BUILTIN_TOOLS as readonly string[]).includes(toolName);
}
