import type { ToolDefinition } from "../types.ts";
import { ROUTES, type PageResponse } from "../../../contracts/src/http.ts";
import { authorLabel, pageIdArg } from "./page_shared.ts";

export const readPageDef: ToolDefinition = {
  name: "read_page",
  visibility: "worker",
  inputSchema: { id: pageIdArg },
  handler: async (ctx, args) => {
    const { id } = args as { id: string };
    const { page } = (await ctx.api("GET", ROUTES.page(id))) as PageResponse;
    const edited = `${new Date(page.updatedAt).toISOString()} by ${authorLabel(page.updatedBy, ctx.selfId)}`;
    return `# ${page.title || "Untitled"}\n(page ${page.id} · rev ${page.rev} · last edited ${edited})\n\n${page.body}`;
  },
};
