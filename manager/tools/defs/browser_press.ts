import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import { BrowserPressRequestSchema } from "../../../contracts/src/browser.ts";
import { resolveTabId } from "./browser_shared.ts";

export const browserPressDef: ToolDefinition = {
  name: "browser_press",
  visibility: "worker",
  inputSchema: {
    tabId: z.string().optional().describe("Tab to act on; omit for the active tab"),
    key: z.string().describe('Key or chord: "Enter", "Tab", "Escape", "Control+a"'),
  },
  handler: async (ctx, args) => {
    const { tabId, ...body } = BrowserPressRequestSchema.parse(args);
    return ctx.api("POST", ROUTES.browserAct(await resolveTabId(ctx, tabId)), body);
  },
};
