// Orchestrator MCP entrypoint. Thin composition root: resolves session, projects
// every ToolDefinition onto the MCP transport (toMcpModule), connects stdio. Tool
// definitions live under tools/defs/ — adding a new MCP-visible tool is one new
// file + one entry in tools/registry.ts.

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { mcpReadyFlagName } from "../contracts/src/util.ts";
import { resolveSession } from "./orchestrator-mcp/SessionContext.ts";
import { orchestratorDefs } from "./tools/registry.ts";
import { toMcpModule } from "./tools/projections.ts";
import { orchestratorCtx } from "./tools/context.ts";
import { renderToolDescriptions, withToolDescriptions } from "./tool-descriptions.ts";

const session = await resolveSession();

// One ToolDefinition -> the MCP transport (toMcpModule). Descriptions are pulled
// from the prompt library (prompts/tool/<name>) and injected at registration; the
// tool definitions carry no inline description.
const modules = orchestratorDefs.map((d) => toMcpModule(d, orchestratorCtx));
const descriptions = renderToolDescriptions(join(import.meta.dirname, "prompts"), modules.map((t) => t.name));
const server = new McpServer({ name: "orchestrator", version: "0.0.1" });
const registrar = withToolDescriptions(server, descriptions);
for (const t of modules) t.register(registrar, session);

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
