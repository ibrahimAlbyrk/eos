import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { resolveSession } from "./worker-mcp/SessionContext.ts";
import { toolModules } from "./worker-mcp/tool-registry.ts";
import { renderToolDescriptions, withToolDescriptions } from "./tool-descriptions.ts";

const session = resolveSession();

// Descriptions pulled from the prompt library (prompts/tool/<name>), injected
// at registration; the tool modules carry no inline description.
const descriptions = await renderToolDescriptions(join(import.meta.dirname, "prompts"), toolModules.map((t) => t.name));
const server = new McpServer({ name: "worker", version: "0.0.1" });
const registrar = withToolDescriptions(server, descriptions);
for (const t of toolModules) t.register(registrar, session);

await server.connect(new StdioServerTransport());
process.stderr.write(
  `[worker-mcp] ready on stdio (id=${session.selfId})\n`,
);
