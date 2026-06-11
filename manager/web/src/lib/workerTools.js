// Verb/label specs for the orchestrator's worker-management MCP tools —
// the single source of truth shared by the chat parser (lane grouping +
// group summaries) and WorkerToolCard (row labels). Result-JSON detail
// rendering stays in WorkerToolCard.

const plural = (n) => `${n} worker${n > 1 ? "s" : ""}`;
const times = (n) => (n > 1 ? ` ×${n}` : "");

export const WORKER_TOOL_SPECS = {
  mcp__orchestrator__spawn_worker: {
    verb: "Spawned",
    running: "Spawning",
    summary: (n) => `Spawned ${plural(n)}`,
  },
  mcp__orchestrator__kill_worker: {
    verb: "Killed",
    running: "Killing",
    summary: (n) => `Killed ${plural(n)}`,
  },
  mcp__orchestrator__message_worker: {
    verb: "Messaged",
    running: "Messaging",
    summary: (n) => `Messaged ${plural(n)}`,
  },
  mcp__orchestrator__get_worker: {
    verb: "Checked",
    running: "Checking",
    summary: (n) => `Checked ${plural(n)}`,
  },
  mcp__orchestrator__list_workers: {
    verb: "Listed",
    running: "Listing",
    summary: (n) => `Listed workers${times(n)}`,
  },
  mcp__orchestrator__list_pending_permissions: {
    verb: "Checked",
    running: "Checking",
    summary: (n) => `Checked pending permissions${times(n)}`,
  },
};

export function isWorkerToolName(name) {
  return Object.hasOwn(WORKER_TOOL_SPECS, name);
}
