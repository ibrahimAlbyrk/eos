// Orchestrator MCP entrypoint. Thin composition root: resolves session,
// registers every tool from the registry, connects stdio. Each tool lives
// in its own file under orchestrator-mcp/tools/ — adding a new MCP-visible
// tool is one new file + one entry in tool-registry.toolModules.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { resolveSession } from "./orchestrator-mcp/SessionContext.ts";
import { toolModules } from "./orchestrator-mcp/tool-registry.ts";

const session = await resolveSession();

const server = new McpServer({ name: "orchestrator", version: "0.0.1" });
for (const t of toolModules) t.register(server, session);

await server.connect(new StdioServerTransport());
process.stderr.write(
  `[orchestrator-mcp] ready on stdio (id=${session.selfId}, cwd=${session.cwd}, git=${session.isGitRepo})\n`,
);
