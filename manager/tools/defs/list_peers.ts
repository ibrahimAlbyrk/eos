import type { ToolDefinition } from "../types.ts";

export const listPeersDef: ToolDefinition = {
  name: "list_peers",
  visibility: "peer",
  inputSchema: {},
  handler: async (ctx) => ctx.api("GET", `/workers/${ctx.selfId}/peers`),
};
