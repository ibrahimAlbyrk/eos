import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DAEMON_URL = process.env.CLAUDE_MGR_DAEMON_URL ?? "http://127.0.0.1:7400";
const SELF_ID = process.env.CLAUDE_MGR_WORKER_ID ?? "orchestrator";

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const r = await fetch(`${DAEMON_URL}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok && r.status !== 201) {
    throw new Error(`daemon ${r.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

const server = new McpServer({ name: "orchestrator", version: "0.0.1" });

server.registerTool(
  "spawn_worker",
  {
    description:
      "Spawn a new background Claude worker to handle a task. Returns the worker ID and port. Prefer providing worktreeFrom (path to a git repo) so the worker runs in an isolated git worktree on its own branch. Use cwd only for read-only investigations.",
    inputSchema: {
      prompt: z.string().describe("The task instruction for the worker. Be specific and self-contained."),
      worktreeFrom: z.string().optional().describe("Absolute path to a git repo. Creates an isolated worktree per worker."),
      cwd: z.string().optional().describe("Absolute working directory (mutually exclusive with worktreeFrom)."),
      name: z.string().optional().describe("Friendly name for the worker (e.g. 'add-auth-tests')."),
      withGateway: z.boolean().optional().describe("Default true. Routes the worker's tool calls through the permission gateway."),
      model: z.string().optional().describe("Claude model for the worker: 'opus' (default, strongest reasoning), 'sonnet' (balanced), or 'haiku' (fastest/cheapest). Pick based on task complexity."),
    },
  },
  async ({ prompt, worktreeFrom, cwd, name, withGateway, model }) => {
    try {
      const res = await api("POST", "/workers", {
        prompt, worktreeFrom, cwd, name, model,
        withGateway: withGateway ?? true,
        parentId: SELF_ID,
      });
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
process.stderr.write("[orchestrator-mcp] ready on stdio\n");
