import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdirSync, appendFileSync, statSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AUDIT_DIR = join(homedir(), ".claude-mgr");
const AUDIT_LOG = join(AUDIT_DIR, "audit.jsonl");
const AUDIT_MAX_BYTES = 10 * 1024 * 1024; // 10MB before rotating
const AUDIT_KEEP = 3;                      // keep audit.jsonl.1 .. .3
mkdirSync(AUDIT_DIR, { recursive: true });

// Cheap size probe — stat is fast and we only call it on permission requests
// (low frequency). Rotates audit.jsonl → audit.jsonl.1, shifting older
// rotations one step. Anything past AUDIT_KEEP is dropped.
function rotateAuditIfLarge() {
  try {
    const st = statSync(AUDIT_LOG);
    if (st.size < AUDIT_MAX_BYTES) return;
  } catch { return; /* no file yet */ }
  try {
    const oldest = `${AUDIT_LOG}.${AUDIT_KEEP}`;
    if (existsSync(oldest)) { try { unlinkSync(oldest); } catch {} }
    for (let i = AUDIT_KEEP - 1; i >= 1; i--) {
      const src = `${AUDIT_LOG}.${i}`;
      const dst = `${AUDIT_LOG}.${i + 1}`;
      if (existsSync(src)) { try { renameSync(src, dst); } catch {} }
    }
    renameSync(AUDIT_LOG, `${AUDIT_LOG}.1`);
  } catch (e) {
    process.stderr.write(`[gateway] audit log rotation failed: ${(e as Error).message}\n`);
  }
}

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

    rotateAuditIfLarge();
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
