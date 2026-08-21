import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import { BrowserFindRequestSchema } from "../../../contracts/src/browser.ts";
import { resolveTabId } from "./browser_shared.ts";

export const browserFindDef: ToolDefinition = {
  name: "browser_find",
  visibility: "worker",
  inputSchema: {
    tabId: z.string().optional().describe("Tab to search; omit for the active tab"),
    query: z.string().describe("Visible text to match, or /regex/ between slashes"),
  },
  handler: async (ctx, args) => {
    const { tabId, ...body } = BrowserFindRequestSchema.parse(args);
    return ctx.api("POST", ROUTES.browserFind(await resolveTabId(ctx, tabId)), body);
  },
};
