import type { ToolDefinition } from "../types.ts";

export const listAvailableWorkersDef: ToolDefinition = {
  name: "list_available_workers",
  visibility: "orchestrator",
  inputSchema: {},
  // Live re-query across all sources visible to this orchestrator (built-in /
  // user / project on disk + its own runtime creates). Covers definitions created after
  // launch, which the prompt-snapshot catalog cannot.
  handler: async (ctx) => ctx.api("GET", `/worker-definitions?owner=${encodeURIComponent(ctx.selfId)}`),
};
