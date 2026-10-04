import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import type { UserMemoryListResponse } from "../../../contracts/src/profile.ts";

export const searchMemoryDef: ToolDefinition = {
  name: "search_memory",
  visibility: "worker",
  inputSchema: {
    query: z.string().max(200).describe("Words to look for, e.g. 'commit style' or 'testing'. Empty lists the newest memories."),
    limit: z.number().int().min(1).max(20).optional().describe("Most results to return (default 8)."),
  },
  handler: async (ctx, args) => {
    const { query, limit } = args as { query: string; limit?: number };
    const params = new URLSearchParams({ q: query, limit: String(limit ?? 8) });
    const { memories } = (await ctx.api("GET", `${ROUTES.userMemorySearch}?${params}`)) as UserMemoryListResponse;
    if (!memories.length) return "No memories match.";
    return memories.map((m) => `- ${m.scope.kind === "project" ? "(this project) " : ""}${m.text}`).join("\n");
  },
};
