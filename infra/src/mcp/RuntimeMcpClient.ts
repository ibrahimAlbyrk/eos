// RuntimeMcpClient — the embedded MCP client adapter (infra) implementing the
// core McpToolClient port over @modelcontextprotocol/sdk. One instance per
// external MCP server resolved for the in-process lane: it builds the right
// client transport from the lane-neutral server config (the same shapes the cli
// JSON / SDK translator handle — stdio | sse | http/streamable-http), performs
// the MCP handshake on connect(), and proxies tools/list + tools/call.
//
// It mirrors the SDK lane's fail-soft posture: connect() THROWS on an
// unreachable/unsupported server so resolveRuntimeMcpTools drops just that server
// (the session continues). close() is best-effort and never throws into teardown.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpToolClient, McpRemoteTool } from "../../../core/src/ports/McpToolClient.ts";

export interface RuntimeMcpClientOpts {
  // Test seam: override transport construction (e.g. an InMemoryTransport linked
  // to an in-process fake server). Production omits it → built from the config.
  makeTransport?(): Transport;
}

// Build the SDK client transport from one resolved server config. Only explicit
// known fields are read, so stray JSON keys never leak. Returns null for an
// unsupported / unrecognized shape (claude.ai connector, plugin-scoped, sdk
// in-process instance) so connect() can fail-soft on it.
function transportFor(config: unknown): Transport | null {
  if (!config || typeof config !== "object") return null;
  const o = config as Record<string, unknown>;
  if (o.type === "sse" && typeof o.url === "string") {
    return new SSEClientTransport(new URL(o.url), o.headers ? { requestInit: { headers: o.headers as Record<string, string> } } : undefined);
  }
  if ((o.type === "http" || o.type === "streamable-http") && typeof o.url === "string") {
    return new StreamableHTTPClientTransport(new URL(o.url), o.headers ? { requestInit: { headers: o.headers as Record<string, string> } } : undefined);
  }
  // stdio: `type` optional in inherited JSON; a string command is the signal.
  if (typeof o.command === "string") {
    return new StdioClientTransport({
      command: o.command,
      ...(Array.isArray(o.args) ? { args: o.args as string[] } : {}),
      ...(o.env ? { env: o.env as Record<string, string> } : {}),
    });
  }
  return null; // unsupported shape → caller drops (logged)
}

export function createRuntimeMcpClient(name: string, config: unknown, opts: RuntimeMcpClientOpts = {}): McpToolClient {
  const client = new Client({ name: "eos-runtime", version: "1" });
  let connected = false;
  return {
    async connect(): Promise<void> {
      const transport = opts.makeTransport ? opts.makeTransport() : transportFor(config);
      if (!transport) throw new Error(`unsupported MCP server shape for "${name}"`);
      await client.connect(transport);
      connected = true;
    },
    async listTools(): Promise<McpRemoteTool[]> {
      const { tools } = await client.listTools();
      return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> | undefined }));
    },
    async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
      const result = await client.callTool({ name: toolName, arguments: args });
      // MCP tool results are a content-block array; concatenate the text blocks
      // (the same shape the gateway verify client reads). Non-text blocks
      // (images/resources) are serialized so nothing is silently dropped.
      const content = Array.isArray(result.content) ? (result.content as Array<Record<string, unknown>>) : [];
      const text = content
        .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : JSON.stringify(b)))
        .join("");
      return text || "(no content)";
    },
    async close(): Promise<void> {
      if (!connected) return;
      try {
        await client.close();
      } catch {
        // best-effort: a transport already torn down by a dead process must not
        // throw into session teardown.
      }
    },
  };
}
