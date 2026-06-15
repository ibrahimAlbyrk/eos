// Orchestrator MCP entrypoint. Thin composition root: resolves session,
// registers every tool from the registry, connects stdio. Each tool lives
// in its own file under orchestrator-mcp/tools/ — adding a new MCP-visible
// tool is one new file + one entry in tool-registry.toolModules.

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { mcpReadyFlagName } from "../contracts/src/util.ts";
import { resolveSession } from "./orchestrator-mcp/SessionContext.ts";
import { toolModules } from "./orchestrator-mcp/tool-registry.ts";
import { renderToolDescriptions, withToolDescriptions } from "./tool-descriptions.ts";

const session = await resolveSession();

// Descriptions are pulled from the prompt library (prompts/tool/<name>) and
// injected at registration; the tool modules carry no inline description.
const descriptions = renderToolDescriptions(join(import.meta.dirname, "prompts"), toolModules.map((t) => t.name));
const server = new McpServer({ name: "orchestrator", version: "0.0.1" });
const registrar = withToolDescriptions(server, descriptions);
for (const t of toolModules) t.register(registrar, session);

await server.connect(new StdioServerTransport());
// Tell the worker this server is connected so it releases the boot prompt
// instead of racing claude's auto-submit (see spawner/worker.ts mcp-ready gate).
const workerId = process.env.EOS_WORKER_ID;
if (workerId) {
  try { writeFileSync(join(tmpdir(), mcpReadyFlagName(workerId)), "1"); } catch {}
}
process.stderr.write(
  `[orchestrator-mcp] ready on stdio (id=${session.selfId}, cwd=${session.cwd}, git=${session.isGitRepo()})\n`,
);
