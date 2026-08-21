import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import { BrowserFillFormRequestSchema } from "../../../contracts/src/browser.ts";
import { resolveTabId } from "./browser_shared.ts";

export const browserFillFormDef: ToolDefinition = {
  name: "browser_fill_form",
  visibility: "worker",
  inputSchema: {
    tabId: z.string().optional().describe("Tab to act on; omit for the active tab"),
    fields: z.array(z.object({
      ref: z.string().describe("Element ref (@eN) of the field"),
      value: z.string().describe("Value to fill in"),
    })).describe("Fields to fill, in order"),
  },
  handler: async (ctx, args) => {
    const { tabId, ...body } = BrowserFillFormRequestSchema.parse(args);
    return ctx.api("POST", ROUTES.browserAct(await resolveTabId(ctx, tabId)), body);
  },
};
