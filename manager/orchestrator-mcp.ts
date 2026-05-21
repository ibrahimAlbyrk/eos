import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawnSync } from "node:child_process";
import { daemonApi } from "./shared/http.ts";

const DAEMON_URL = process.env.CLAUDE_MGR_DAEMON_URL ?? "http://127.0.0.1:7400";
const SELF_ID = process.env.CLAUDE_MGR_WORKER_ID ?? "orchestrator";

const api = (method: string, path: string, body?: unknown) => daemonApi(DAEMON_URL, method, path, body);

// Resolve own cwd from daemon. Workers spawned via spawn_worker MUST run in
// this directory — the LLM cannot override it. If the cwd is a git repo we
// route through a worktree (isolation on its own branch); otherwise plain cwd.
const self = (await api("GET", `/workers/${SELF_ID}`)) as { cwd?: string | null };
const ORCH_CWD = (self.cwd ?? "").trim();
if (!ORCH_CWD) {
  process.stderr.write(`[orchestrator-mcp] FATAL: self (${SELF_ID}) has no cwd in daemon\n`);
  process.exit(1);
}
const gitCheck = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: ORCH_CWD, encoding: "utf8" });
const ORCH_IS_GIT_REPO = gitCheck.status === 0;

const server = new McpServer({ name: "orchestrator", version: "0.0.1" });

server.registerTool(
  "spawn_worker",
  {
    description:
      "Spawn a new background Claude worker to handle a task. Returns the worker ID and port. The worker automatically runs in your project directory — you do not (and cannot) choose the path.",
    inputSchema: {
      prompt: z.string().describe("The task instruction for the worker. Be specific and self-contained."),
      name: z.string().optional().describe("Friendly name for the worker (e.g. 'add-auth-tests')."),
      withGateway: z.boolean().optional().describe("Default true. Routes the worker's tool calls through the permission gateway."),
      model: z.string().optional().describe("Claude model for the worker: 'opus' (default, strongest reasoning), 'sonnet' (balanced), or 'haiku' (fastest/cheapest). Pick based on task complexity."),
      maxCostUsd: z.number().optional().describe("Hard ceiling in USD. Worker SIGTERM'd if cumulative cost exceeds this. Useful for budget-bounded delegations."),
      maxElapsedMs: z.number().optional().describe("Hard ceiling in milliseconds since worker started. Useful as a watchdog against runaway turns."),
    },
  },
  async ({ prompt, name, withGateway, model, maxCostUsd, maxElapsedMs }) => {
    try {
      const body: Record<string, unknown> = {
        prompt, name, model,
        withGateway: withGateway ?? true,
        parentId: SELF_ID,
        maxCostUsd, maxElapsedMs,
      };
      if (ORCH_IS_GIT_REPO) body.worktreeFrom = ORCH_CWD;
      else body.cwd = ORCH_CWD;
      const res = await api("POST", "/workers", body);
      return { content: [{ type: "text" as const, text: JSON.stringify(res) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `error: ${(e as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "list_workers",
  {
    description: "List all workers managed by claude-manager (active and completed). Returns id, state, branch, duration, prompt summary.",
    inputSchema: {},
  },
  async () => {
    try {
      const rows = (await api("GET", "/workers")) as Array<Record<string, unknown>>;
      const summary = rows.slice(0, 30).map((w) => ({
        id: w.id, state: w.state, branch: w.branch ?? null,
        started_at: w.started_at, ended_at: w.ended_at,
        prompt: String(w.prompt ?? "").slice(0, 100),
      }));
      return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `error: ${(e as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "get_worker",
  {
    description: "Get a worker's current state and recent events. Use this to check progress on a previously spawned worker.",
    inputSchema: { id: z.string().describe("Worker id, e.g. 'w-abcd1234'") },
  },
  async ({ id }) => {
    try {
      const [w, ev] = await Promise.all([
        api("GET", `/workers/${id}`),
        api("GET", `/workers/${id}/events?limit=30`),
      ]);
      return { content: [{ type: "text" as const, text: JSON.stringify({ worker: w, events: ev }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `error: ${(e as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "kill_worker",
  {
    description: "Terminate a running worker via SIGTERM. Use when a worker is stuck or its task is no longer needed.",
    inputSchema: { id: z.string().describe("Worker id") },
  },
  async ({ id }) => {
    try {
      const res = await api("DELETE", `/workers/${id}`);
      return { content: [{ type: "text" as const, text: JSON.stringify(res) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `error: ${(e as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "list_pending_permissions",
  {
    description: "List pending permission requests waiting for human approval (from worker tool calls that hit policy 'ask' rules).",
    inputSchema: {},
  },
  async () => {
    try {
      const rows = await api("GET", "/pending");
      return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `error: ${(e as Error).message}` }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());
process.stderr.write(`[orchestrator-mcp] ready on stdio (id=${SELF_ID}, cwd=${ORCH_CWD}, git=${ORCH_IS_GIT_REPO})\n`);
