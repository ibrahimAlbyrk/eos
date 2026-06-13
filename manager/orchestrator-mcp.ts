// Orchestrator MCP entrypoint. Thin composition root: resolves session,
// registers every tool from the registry, connects stdio. Each tool lives
// in its own file under orchestrator-mcp/tools/ — adding a new MCP-visible
// tool is one new file + one entry in tool-registry.toolModules.

import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { resolveSession } from "./orchestrator-mcp/SessionContext.ts";
import { toolModules } from "./orchestrator-mcp/tool-registry.ts";
import { renderToolDescriptions, withToolDescriptions } from "./tool-descriptions.ts";

const session = await resolveSession();

// Descriptions are pulled from the prompt library (prompts/tool/<name>) and
// injected at registration; the tool modules carry no inline description.
const descriptions = await renderToolDescriptions(join(import.meta.dirname, "prompts"), toolModules.map((t) => t.name));
const server = new McpServer({ name: "orchestrator", version: "0.0.1" });
const registrar = withToolDescriptions(server, descriptions);
for (const t of toolModules) t.register(registrar, session);

await server.connect(new StdioServerTransport());
process.stderr.write(
  `[orchestrator-mcp] ready on stdio (id=${session.selfId}, cwd=${session.cwd}, git=${session.isGitRepo()})\n`,
);
