import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { mcpReadyFlagName } from "../contracts/src/util.ts";
import { resolveSession } from "./worker-mcp/SessionContext.ts";
import { toolModules, peerToolModules } from "./worker-mcp/tool-registry.ts";
import { renderToolDescriptions, withToolDescriptions } from "./tool-descriptions.ts";

const session = resolveSession();

// Peer tools (list_peers / ask_peer / respond_to_peer) are registered only for
// a collaborate-enabled worker — so a non-collaborating worker never sees them.
const mods = session.collaborate ? [...toolModules, ...peerToolModules] : toolModules;

// Descriptions pulled from the prompt library (prompts/tool/<name>), injected
// at registration; the tool modules carry no inline description.
const descriptions = renderToolDescriptions(join(import.meta.dirname, "prompts"), mods.map((t) => t.name));
const server = new McpServer({ name: "worker", version: "0.0.1" });
const registrar = withToolDescriptions(server, descriptions);
for (const t of mods) t.register(registrar, session);

await server.connect(new StdioServerTransport());
// Tell the worker this server is connected so it releases the boot prompt
// instead of racing claude's auto-submit (see spawner/worker.ts mcp-ready gate).
const workerId = process.env.EOS_WORKER_ID;
if (workerId) {
  try { writeFileSync(join(tmpdir(), mcpReadyFlagName(workerId)), "1"); } catch {}
}
process.stderr.write(
  `[worker-mcp] ready on stdio (id=${session.selfId})\n`,
);
