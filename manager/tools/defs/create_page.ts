import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { ROUTES, PAGE_TITLE_MAX, type PageResponse } from "../../../contracts/src/http.ts";

export const createPageDef: ToolDefinition = {
  name: "create_page",
  visibility: "worker",
  inputSchema: {
    title: z.string().min(1).max(PAGE_TITLE_MAX).describe("Short title the user will recognise in the page list."),
    body: z.string().default("").describe("Markdown content. Checklists use '- [ ] item'."),
  },
  handler: async (ctx, args) => {
    const { title, body } = args as { title: string; body: string };
    const { page } = (await ctx.api("POST", ROUTES.pages, { title, body })) as PageResponse;
    return { id: page.id, title: page.title, rev: page.rev };
  },
};
