import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import { BrowserShowRequestSchema } from "../../../contracts/src/browser.ts";

export const browserShowDef: ToolDefinition = {
  name: "browser_show",
  visibility: "worker",
  inputSchema: {
    tabId: z.string().optional().describe("Tab to present; omit for your session's active tab"),
  },
  handler: async (ctx, args) =>
    ctx.api("POST", ROUTES.browserShow, BrowserShowRequestSchema.parse(args)),
};
