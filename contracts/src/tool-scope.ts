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
