import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import { BrowserScrollRequestSchema } from "../../../contracts/src/browser.ts";
import { resolveTabId } from "./browser_shared.ts";

export const browserScrollDef: ToolDefinition = {
  name: "browser_scroll",
  visibility: "worker",
  inputSchema: {
    tabId: z.string().optional().describe("Tab to scroll; omit for the active tab"),
    direction: z.enum(["up", "down", "top", "bottom"]).describe("up/down = one viewport; top/bottom = jump to the edge"),
    ref: z.string().optional().describe("Scroll this container instead of the page"),
  },
  handler: async (ctx, args) => {
    const { tabId, ...body } = BrowserScrollRequestSchema.parse(args);
    return ctx.api("POST", ROUTES.browserAct(await resolveTabId(ctx, tabId)), body);
  },
};
