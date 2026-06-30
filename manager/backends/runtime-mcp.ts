// External-MCP tool resolution for the in-process lane (§5c) — the third MCP
// emit/consume adapter, symmetric to the cli JSON path and the SDK's
// resolveSdkMcpServers. Given the lane-neutral resolved server map (from core's
// resolveMcpServers), it connects an embedded McpToolClient per server, lists its
// tools, and wraps each remote tool as a RuntimeTool named mcp__<server>__<tool>.
// Those names classify as the always-allow `mcp` category, so they enter the SAME
// ToolRuntime dispatch + policy gate as every other tool — no loop change.
//
// FAIL-SOFT (mirrors the SDK lane's drop+log): a server that fails connect or
// tools/list is dropped (its half-open client closed) and the rest proceed — one
// dead/unreachable server never sinks the session. The returned close() tears down
// every surviving client at session stop; the connections are session-scoped.

import type { McpToolClient, McpToolClientFactory } from "../../core/src/ports/McpToolClient.ts";
import type { RuntimeTool } from "../../core/src/use-cases/ToolRuntime.ts";
import type { LaneToolItem } from "./lane-tooling.ts";

export interface RuntimeMcpToolset {
  items: LaneToolItem[];
  tools: Map<string, RuntimeTool>;
  close(): Promise<void>;
}

const EMPTY_SCHEMA: Record<string, unknown> = { type: "object", properties: {} };

export interface RuntimeMcpLog {
  warn(message: string, meta?: unknown): void;
}

export async function connectRuntimeMcpTools(
  servers: Record<string, unknown>,
  makeClient: McpToolClientFactory,
  log?: RuntimeMcpLog,
): Promise<RuntimeMcpToolset> {
  const items: LaneToolItem[] = [];
  const tools = new Map<string, RuntimeTool>();
  const open: McpToolClient[] = [];

  for (const [server, config] of Object.entries(servers)) {
    const client = makeClient(server, config);
    try {
      await client.connect();
      const remote = await client.listTools();
      for (const t of remote) {
        const name = `mcp__${server}__${t.name}`;
        items.push({ name, description: t.description ?? name, schema: t.inputSchema ?? EMPTY_SCHEMA });
        // Bind THIS client + the remote (unprefixed) tool name into the executor.
        tools.set(name, { name, execute: (input) => client.callTool(t.name, input) });
      }
      open.push(client);
    } catch (e) {
      // Drop just this server; close its half-open transport best-effort.
      log?.warn("external MCP server dropped (fail-soft)", { server, error: e instanceof Error ? e.message : String(e) });
      void client.close().catch(() => {});
    }
  }

  return {
    items,
    tools,
    async close() {
      await Promise.all(open.map((c) => c.close().catch(() => {})));
    },
  };
}
