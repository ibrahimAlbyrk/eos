import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { resolveSession } from "./worker-mcp/SessionContext.ts";
import { toolModules } from "./worker-mcp/tool-registry.ts";

const session = resolveSession();

const server = new McpServer({ name: "worker", version: "0.0.1" });
for (const t of toolModules) t.register(server, session);

await server.connect(new StdioServerTransport());
process.stderr.write(
  `[worker-mcp] ready on stdio (id=${session.selfId})\n`,
);
