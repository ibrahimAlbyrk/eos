// Shared plumbing for the page tools: the daemon routes they call and the
// compact shapes they hand back to the model (an edit answers with the new rev,
// not the whole page, to keep tool results small).

import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { ROUTES, type Page, type PageAuthor, type PageEditRequest } from "../../../contracts/src/http.ts";

export const pageIdArg = z.string().describe("Page id, e.g. 'pg-3f9a1c2b7d10' (from list_pages or create_page)");

export function authorLabel(by: PageAuthor, selfId: string): string {
  if (by.kind === "user") return "the user";
  if (by.agentId === selfId) return "you";
  return by.name ? `agent ${by.name}` : `agent ${by.agentId ?? "unknown"}`;
}

export async function editPage(ctx: ToolContext, id: string, edit: PageEditRequest): Promise<{ id: string; rev: number }> {
  const { page } = (await ctx.api("POST", ROUTES.pageEdit(id), edit)) as { page: Page };
  return { id: page.id, rev: page.rev };
}
