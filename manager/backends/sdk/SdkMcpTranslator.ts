// SDK-side emit adapter — the symmetric counterpart to the cli lane's JSON
// serialization (container.ts writeMcpConfig). Translates the lane-neutral
// resolved server map from core's resolveMcpServers (mixed: in-process SDK
// instances from createSdkMcpServer + raw external JSON entries inherited from
// ~/.claude.json / .mcp.json) into the SDK's McpServerConfig union for query().
//
// It NEVER throws: any unrecognized / unsupported entry (claude.ai connector,
// plugin-scoped types with no SDK union variant, malformed JSON) is DROPPED and
// reported, so one bad inherited entry can never sink the worker.

import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

export interface DroppedServer {
  name: string;
  reason: string;
}

export function toSdkMcpServers(
  servers: Record<string, unknown>,
): { mcpServers: Record<string, McpServerConfig>; dropped: DroppedServer[] } {
  const mcpServers: Record<string, McpServerConfig> = {};
  const dropped: DroppedServer[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    const cfg = coerce(raw);
    if (cfg) mcpServers[name] = cfg;
    else dropped.push({ name, reason: "unsupported MCP server shape" });
  }
  return { mcpServers, dropped };
}

// Only explicit known fields are rebuilt, so stray JSON keys never leak into the
// SDK call. alwaysLoad is deliberately NOT propagated to external servers (left
// unset → non-blocking lazy connect, so a slow/dead external server can't block
// turn-1 startup).
function coerce(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  // Eos in-process server: pass the live instance through untouched.
  if (o.type === "sdk" || "instance" in o) return raw as McpServerConfig;
  if (o.type === "sse") {
    return { type: "sse", url: String(o.url), ...(o.headers ? { headers: o.headers as Record<string, string> } : {}) } as McpServerConfig;
  }
  // "streamable-http" is a .mcp.json alias; the programmatic union accepts only "http".
  if (o.type === "http" || o.type === "streamable-http") {
    return { type: "http", url: String(o.url), ...(o.headers ? { headers: o.headers as Record<string, string> } : {}) } as McpServerConfig;
  }
  // stdio: `type` is optional in inherited JSON; a string command is the signal.
  if (typeof o.command === "string") {
    return {
      type: "stdio",
      command: o.command,
      ...(o.args ? { args: o.args as string[] } : {}),
      ...(o.env ? { env: o.env as Record<string, string> } : {}),
    } as McpServerConfig;
  }
  return null; // claude.ai connector / plugin-scoped / unknown → drop (logged by caller)
}
