import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { ROUTES, type PageListResponse } from "../../../contracts/src/http.ts";
import { authorLabel } from "./page_shared.ts";

export const listPagesDef: ToolDefinition = {
  name: "list_pages",
  visibility: "worker",
  inputSchema: {
    query: z.string().optional().describe("Only pages whose title or text contains this (case-insensitive)."),
    all: z.boolean().default(false).describe("true = pages from every project, not just the one this chat works in."),
  },
  handler: async (ctx, args) => {
    const { query, all } = args as { query?: string; all: boolean };
    const qs = new URLSearchParams();
    if (query) qs.set("q", query);
    if (all) qs.set("all", "1");
    const search = qs.toString();
    const { pages } = (await ctx.api("GET", search ? `${ROUTES.pages}?${search}` : ROUTES.pages)) as PageListResponse;
    return {
      pages: pages.map((p) => ({
        id: p.id,
        title: p.title || "Untitled",
        excerpt: p.excerpt,
        openTasks: p.tasks.open,
        doneTasks: p.tasks.done,
        updatedAt: new Date(p.updatedAt).toISOString(),
        updatedBy: authorLabel(p.updatedBy, ctx.selfId),
        ...(all ? { project: p.project } : {}),
      })),
    };
  },
};
