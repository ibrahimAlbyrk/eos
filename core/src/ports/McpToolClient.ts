// McpToolClient — the embedded MCP client seam for the in-process (metered API)
// lane. One client per configured external MCP server; resolveRuntimeMcpTools
// connects each, lists its tools, and wraps every remote tool as a RuntimeTool
// named mcp__<server>__<tool> that flows through the SAME ToolRuntime dispatch +
// policy gate as any other tool (classifyTool always-allows the mcp category).
//
// The infra adapter (RuntimeMcpClient) implements this over
// @modelcontextprotocol/sdk; tests provide a fake. The port is deliberately tiny
// (ISP) and transport-agnostic — it knows nothing about stdio/sse/http, which the
// adapter owns from the resolved server config.

export interface McpRemoteTool {
  name: string;
  description?: string;
  // The tool's input JSON schema (tools/list). Surfaced to the model verbatim.
  inputSchema?: Record<string, unknown>;
}

export interface McpToolClient {
  // Establish the transport + MCP handshake. THROWS on an unreachable/dead server
  // — the caller drops that one server (fail-soft) rather than crashing the session.
  connect(): Promise<void>;
  // tools/list — the remote tool inventory (call after connect).
  listTools(): Promise<McpRemoteTool[]>;
  // tools/call — the textual result fed back to the model as a tool_result.
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  // Close the transport at session teardown. Best-effort; never throws.
  close(): Promise<void>;
}

// Builds a client for one resolved server (its name + the lane-neutral config
// object from resolveMcpServers). Injected so tests swap a fake for the SDK adapter.
export type McpToolClientFactory = (name: string, config: unknown) => McpToolClient;
