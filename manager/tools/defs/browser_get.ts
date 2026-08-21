import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import { BrowserGetRequestSchema } from "../../../contracts/src/browser.ts";
import { resolveTabId } from "./browser_shared.ts";

export const browserGetDef: ToolDefinition = {
  name: "browser_get",
  visibility: "worker",
  inputSchema: {
    tabId: z.string().optional().describe("Tab to read; omit for the active tab"),
    what: z.enum(["text", "url", "title", "value"]).describe('"url"/"title" are page-level; "text"/"value" read one element and need `ref`'),
    ref: z.string().optional().describe('Element ref (@eN) — required for "text" and "value"'),
  },
  handler: async (ctx, args) => {
    const { tabId, ...body } = BrowserGetRequestSchema.parse(args);
    return ctx.api("POST", ROUTES.browserGet(await resolveTabId(ctx, tabId)), body);
  },
};
