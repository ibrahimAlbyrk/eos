import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { mcpReadyFlagName } from "../contracts/src/util.ts";
import { resolveSession } from "./worker-mcp/SessionContext.ts";
import { workerDefs, peerDefs, homeDefs } from "./tools/registry.ts";
import { toMcpModule } from "./tools/projections.ts";
import { workerCtx } from "./tools/context.ts";
import { renderToolDescriptions, withToolDescriptions } from "./tool-descriptions.ts";

const session = resolveSession();

// A Home session sees no Eos control tools (built-ins only). Otherwise: the
// general worker surface, with the peer tools (list_peers / ask_peer /
// respond_to_peer) only when collaborate=true.
const defs = session.role === "home"
  ? homeDefs
  : session.collaborate ? [...workerDefs, ...peerDefs] : workerDefs;
const mods = defs.map((d) => toMcpModule(d, workerCtx));

// Descriptions pulled from the prompt library (prompts/tool/<name>), injected
// at registration; the tool definitions carry no inline description.
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
