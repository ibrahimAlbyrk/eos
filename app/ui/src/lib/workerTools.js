// Verb/label specs for the orchestrator's worker-management tools —
// the single source of truth shared by the chat parser (lane grouping +
// group summaries) and WorkerToolCard (row labels). Result-JSON detail
// rendering stays in WorkerToolCard.

const plural = (n) => `${n} worker${n > 1 ? "s" : ""}`;
const times = (n) => (n > 1 ? ` ×${n}` : "");

export const WORKER_TOOL_SPECS = {
  spawn_worker: {
    verb: "Spawned",
    running: "Spawning",
    summary: (n) => `Spawned ${plural(n)}`,
  },
  kill_worker: {
    verb: "Killed",
    running: "Killing",
    summary: (n) => `Killed ${plural(n)}`,
  },
  message_worker: {
    verb: "Messaged",
    running: "Messaging",
    summary: (n) => `Messaged ${plural(n)}`,
  },
  get_worker: {
    verb: "Checked",
    running: "Checking",
    summary: (n) => `Checked ${plural(n)}`,
  },
  list_active_workers: {
    verb: "Listed",
    running: "Listing",
    summary: (n) => `Listed workers${times(n)}`,
  },
  list_pending_permissions: {
    verb: "Checked",
    running: "Checking",
    summary: (n) => `Checked pending permissions${times(n)}`,
  },
};

export function isWorkerToolName(name) {
  return Object.hasOwn(WORKER_TOOL_SPECS, name);
}
