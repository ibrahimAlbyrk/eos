import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import { BrowserNewTabRequestSchema } from "../../../contracts/src/browser.ts";

export const browserNewTabDef: ToolDefinition = {
  name: "browser_new_tab",
  visibility: "worker",
  inputSchema: {
    url: z.string().optional().describe("URL to open the tab at; omit for the default start page"),
  },
  handler: async (ctx, args) => {
    const body = BrowserNewTabRequestSchema.parse(args);
    return ctx.api("POST", ROUTES.browserTabs, body);
  },
};
