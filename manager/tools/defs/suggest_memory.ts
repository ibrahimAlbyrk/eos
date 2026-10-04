import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import type { UserMemorySuggestResponse } from "../../../contracts/src/profile.ts";

export const suggestMemoryDef: ToolDefinition = {
  name: "suggest_memory",
  visibility: "worker",
  inputSchema: {
    text: z.string().min(1).max(500).describe("One self-contained sentence about the user, e.g. 'Prefers pnpm over npm.'"),
    category: z.enum(["about", "work-style", "stack", "other"]).describe("about = who the user is; work-style = how they want work done; stack = tools and technologies."),
    scope: z.enum(["global", "project"]).describe("project = only true in the current project (its conventions); global = true everywhere."),
    why: z.string().max(300).optional().describe("What the user said or did that shows it — shown to the user when they review."),
  },
  handler: async (ctx, args) => {
    // The id lets the transcript card follow the suggestion live (kept / dismissed).
    const r = (await ctx.api("POST", ROUTES.userMemorySuggest, args)) as UserMemorySuggestResponse;
    if (r.declined) return `Declined before (${r.memory.id}): the user dismissed this idea. Don't suggest it again.`;
    if (r.duplicate) return `Already known (${r.memory.id}): "${r.memory.text}". Nothing to do.`;
    return `Suggested (${r.memory.id}). The user reviews it in Eos before it is remembered — no need to mention it.`;
  },
};
