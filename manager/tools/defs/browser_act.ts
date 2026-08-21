import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import { BrowserActRequestSchema } from "../../../contracts/src/browser.ts";
import { resolveTabId } from "./browser_shared.ts";

export const browserActDef: ToolDefinition = {
  name: "browser_act",
  visibility: "worker",
  inputSchema: {
    tabId: z.string().optional().describe("Tab to act on; omit for the active tab"),
    ref: z.string().describe("Element ref (@eN) from browser_snapshot or browser_find"),
    verb: z.enum(["click", "hover", "focus", "check", "uncheck"]).describe("What to do to the element"),
    includeSnapshot: z.boolean().default(false).describe("Return a fresh snapshot with the result (token-expensive — request only when you need to see the outcome)"),
  },
  handler: async (ctx, args) => {
    const { tabId, ...body } = BrowserActRequestSchema.parse(args);
    return ctx.api("POST", ROUTES.browserAct(await resolveTabId(ctx, tabId)), body);
  },
};
