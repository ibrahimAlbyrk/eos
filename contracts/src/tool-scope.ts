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
// instead. Workflow is claude's built-in CLI/SDK orchestration harness, which
// has no surface in Eos either — orchestration goes through the
// mcp__orchestrator__workflow tool, so the built-in is removed entirely.
// Enforced at every layer that can fire: auto-allow.sh (PermissionRequest),
// spawner PreToolUse (the only gate under native bypassPermissions), and
// PolicyGatewayService step 0 (ahead of user rules).
export const BLOCKED_BUILTIN_TOOLS = ["AskUserQuestion", "Workflow"] as const;

const BLOCKED_BUILTIN_TOOL_MESSAGES: Record<string, string> = {
  AskUserQuestion:
    "AskUserQuestion is disabled in Eos — its native menu has no answer surface here. " +
    "Orchestrator: ask the operator via mcp__orchestrator__ask_user. " +
    "Worker: proceed on your best judgment or report `needs input: <ask>` to your parent.",
  Workflow:
    "The built-in Workflow tool is disabled in Eos — orchestrate via the mcp__orchestrator__workflow tool instead.",
};

export function blockedBuiltinToolMessage(toolName: string): string {
  return BLOCKED_BUILTIN_TOOL_MESSAGES[toolName] ?? `${toolName} is disabled in Eos.`;
}

export function isBlockedBuiltinTool(toolName: string): boolean {
  return (BLOCKED_BUILTIN_TOOLS as readonly string[]).includes(toolName);
}

// Built-in tools removed for ORCHESTRATORS ONLY. An orchestrator decomposes work
// via mcp__orchestrator__spawn_worker (real Eos workers), never via claude's
// internal Task subagents — so Task is removed from its tool surface. Regular
// workers KEEP Task (they legitimately spawn Explore/Plan/general-purpose
// subagents), so this set is role-scoped and deliberately SEPARATE from the
// platform-wide BLOCKED_BUILTIN_TOOLS — merging the two would re-ban worker
// subagents.
export const ORCHESTRATOR_DISALLOWED_BUILTIN_TOOLS = ["Task"] as const;

// The disallowed-tools list handed to the claude binary (CLI --disallowedTools /
// SDK disallowedTools) for a spawn, keyed on the session-immutable isOrchestrator
// fact: the platform-wide set, plus the orchestrator-only set when applicable.
export function disallowedBuiltinToolsFor(isOrchestrator: boolean): string[] {
  return isOrchestrator
    ? [...BLOCKED_BUILTIN_TOOLS, ...ORCHESTRATOR_DISALLOWED_BUILTIN_TOOLS]
    : [...BLOCKED_BUILTIN_TOOLS];
}
