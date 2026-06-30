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

// Bounded per-server connect budget. A slow or unreachable server (e.g. an
// auth-failing endpoint) is dropped at this cap instead of stalling session
// start — the in-process lane has no binary to background MCP for it, so an
// unbounded handshake is felt directly as startup lag.
const CONNECT_TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export async function connectRuntimeMcpTools(
  servers: Record<string, unknown>,
  makeClient: McpToolClientFactory,
  log?: RuntimeMcpLog,
): Promise<RuntimeMcpToolset> {
  const items: LaneToolItem[] = [];
  const tools = new Map<string, RuntimeTool>();
  const open: McpToolClient[] = [];

  // Connect every server in PARALLEL under a bounded timeout — total startup cost
  // is the slowest single server (capped), never the sum, so one dead/slow server
  // no longer serializes seconds of lag in front of the first turn. Still fail-soft
  // per server (drop + close + log); order is preserved by Promise.all.
  const settled = await Promise.all(
    Object.entries(servers).map(async ([server, config]) => {
      const client = makeClient(server, config);
      try {
        await withTimeout(client.connect(), CONNECT_TIMEOUT_MS, `mcp connect ${server}`);
        const remote = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `mcp tools/list ${server}`);
        return { server, client, remote };
      } catch (e) {
        // Drop just this server; close its half-open transport best-effort.
        log?.warn("external MCP server dropped (fail-soft)", { server, error: e instanceof Error ? e.message : String(e) });
        void client.close().catch(() => {});
        return null;
      }
    }),
  );

  for (const r of settled) {
    if (!r) continue;
    for (const t of r.remote) {
      const name = `mcp__${r.server}__${t.name}`;
      items.push({ name, description: t.description ?? name, schema: t.inputSchema ?? EMPTY_SCHEMA });
      // Bind THIS client + the remote (unprefixed) tool name into the executor.
      tools.set(name, { name, execute: (input) => r.client.callTool(t.name, input) });
    }
    open.push(r.client);
  }

  return {
    items,
    tools,
    async close() {
      await Promise.all(open.map((c) => c.close().catch(() => {})));
    },
  };
}
