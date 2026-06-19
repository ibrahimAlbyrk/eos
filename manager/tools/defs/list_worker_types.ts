import type { ToolDefinition } from "../types.ts";

export const listWorkerTypesDef: ToolDefinition = {
  name: "list_worker_types",
  visibility: "orchestrator",
  inputSchema: {},
  // Live re-query across all sources visible to this orchestrator (built-in /
  // user / project on disk + its own runtime mints). Covers types minted after
  // launch, which the prompt-snapshot catalog cannot.
  handler: async (ctx) => ctx.api("GET", `/worker-types?owner=${encodeURIComponent(ctx.selfId)}`),
};
