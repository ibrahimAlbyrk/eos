import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AUDIT_DIR = join(homedir(), ".claude-mgr");
const AUDIT_LOG = join(AUDIT_DIR, "audit.jsonl");
mkdirSync(AUDIT_DIR, { recursive: true });

const DAEMON_URL = process.env.CLAUDE_MGR_DAEMON_URL;
const WORKER_ID = process.env.CLAUDE_MGR_WORKER_ID;
const DAEMON_MODE = !!(DAEMON_URL && WORKER_ID);
process.stderr.write(`[gateway] mode=${DAEMON_MODE ? `daemon (${DAEMON_URL} as ${WORKER_ID})` : "standalone"}\n`);

type AllowDecision = { behavior: "allow"; updatedInput: Record<string, unknown> };
type DenyDecision = { behavior: "deny"; message: string };
type Decision = AllowDecision | DenyDecision;

function decideBash(cmd: string, input: Record<string, unknown>): Decision {
  if (/(^|[\s;&|])rm\s+-[rRf]+/.test(cmd))
    return { behavior: "deny", message: "rm -rf is hard-blocked by gateway policy" };
  if (/(^|[\s;&|])git\s+push\b/.test(cmd))
    return { behavior: "deny", message: "agents may not push; orchestrator handles merges" };
  if (/^\s*sudo\b/.test(cmd))
    return { behavior: "deny", message: "sudo is blocked" };
  if (/(^|[\s;&|])curl\b/.test(cmd) && !/--max-time/.test(cmd)) {
    return {
      behavior: "allow",
      updatedInput: { ...input, command: cmd.replace(/(^|[\s;&|])curl\b/, "$1curl --max-time 10") },
    };
  }
  return { behavior: "allow", updatedInput: input };
}

function decide(toolName: string, input: Record<string, unknown>): Decision {
  if (toolName === "Bash") {
    const cmd = String(input.command ?? "");
    return decideBash(cmd, input);
  }
  return { behavior: "allow", updatedInput: input };
}

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
    let decision: Decision;
    if (DAEMON_MODE) {
      try {
        const r = await fetch(`${DAEMON_URL}/policy/decide`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ worker_id: WORKER_ID, tool_name, input, tool_use_id }),
        });
        decision = (await r.json()) as Decision;
      } catch (e) {
        decision = { behavior: "deny", message: `daemon unreachable: ${(e as Error).message}` };
      }
    } else {
      decision = decide(tool_name, input as Record<string, unknown>);
    }

    appendFileSync(
      AUDIT_LOG,
      JSON.stringify({
        ts: new Date().toISOString(),
        mode: DAEMON_MODE ? "daemon" : "standalone",
        tool: tool_name,
        input,
        tool_use_id,
        decision,
      }) + "\n"
    );

    const tag =
      decision.behavior === "deny"
        ? `deny (${decision.message})`
        : decision.behavior === "allow" && decision.updatedInput !== input
          ? "allow + rewrite"
          : "allow";
    process.stderr.write(`[gateway] ${tool_name} -> ${tag}\n`);

    return {
      content: [{ type: "text" as const, text: JSON.stringify(decision) }],
    };
  }
);

await server.connect(new StdioServerTransport());
process.stderr.write("[gateway] ready on stdio\n");
