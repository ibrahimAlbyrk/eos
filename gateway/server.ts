// Gateway entrypoint — registers a single MCP tool (`decide`) whose
// implementation is delegated to the resolver Strategy chosen at startup
// (daemon-proxy when CLAUDE_MGR_DAEMON_URL + CLAUDE_MGR_WORKER_ID are set;
// standalone otherwise). Every decision is appended to the audit log.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { AuditLog } from "./AuditLog.ts";
import { standalonePolicy } from "./StandalonePolicy.ts";
import { createDaemonProxyPolicy } from "./DaemonProxyPolicy.ts";
import type { PolicyResolver } from "./PolicyResolver.ts";

const DAEMON_URL = process.env.CLAUDE_MGR_DAEMON_URL;
const WORKER_ID = process.env.CLAUDE_MGR_WORKER_ID;

const resolver: PolicyResolver = DAEMON_URL && WORKER_ID
  ? createDaemonProxyPolicy({ daemonUrl: DAEMON_URL, workerId: WORKER_ID })
  : standalonePolicy;

process.stderr.write(
  `[gateway] mode=${resolver.name}${resolver.name === "daemon" ? ` (${DAEMON_URL} as ${WORKER_ID})` : ""}\n`,
);

const audit = new AuditLog();

const server = new McpServer({ name: "gateway", version: "0.0.1" });

server.registerTool(
  "decide",
  {
    description:
      "Permission gateway for Claude Code. Returns allow/deny with optional input rewrite. Wired via --permission-prompt-tool mcp__gateway__decide.",
    inputSchema: {
      tool_name: z.string(),
      input: z.record(z.string(), z.unknown()),
      tool_use_id: z.string().optional(),
    },
  },
  async ({ tool_name, input, tool_use_id }) => {
    const decision = await resolver.decide({ tool_name, input, tool_use_id });
    audit.append({
      ts: new Date().toISOString(),
      mode: resolver.name,
      tool: tool_name,
      input,
      tool_use_id,
      decision,
    });
    const tag =
      decision.behavior === "deny"
        ? `deny (${decision.message})`
        : decision.updatedInput !== input
          ? "allow + rewrite"
          : "allow";
    process.stderr.write(`[gateway] ${tool_name} -> ${tag}\n`);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(decision) }],
    };
  },
);

await server.connect(new StdioServerTransport());
process.stderr.write("[gateway] ready on stdio\n");
