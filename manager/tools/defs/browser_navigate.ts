import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import { BrowserNavigateRequestSchema } from "../../../contracts/src/browser.ts";
import { resolveTabId } from "./browser_shared.ts";

export const browserNavigateDef: ToolDefinition = {
  name: "browser_navigate",
  visibility: "worker",
  inputSchema: {
    tabId: z.string().optional().describe("Tab to drive; omit for the active tab"),
    action: z.enum(["url", "back", "forward", "reload"]).describe('"url" loads `url`; back/forward walk history; reload refreshes'),
    url: z.string().optional().describe('Target URL — required when action is "url"'),
  },
  handler: async (ctx, args) => {
    const { tabId, ...body } = BrowserNavigateRequestSchema.parse(args);
    return ctx.api("POST", ROUTES.browserNavigate(await resolveTabId(ctx, tabId)), body);
  },
};
