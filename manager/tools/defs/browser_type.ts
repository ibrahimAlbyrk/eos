import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import { BrowserTypeRequestSchema } from "../../../contracts/src/browser.ts";
import { resolveTabId } from "./browser_shared.ts";

export const browserTypeDef: ToolDefinition = {
  name: "browser_type",
  visibility: "worker",
  inputSchema: {
    tabId: z.string().optional().describe("Tab to act on; omit for the active tab"),
    ref: z.string().describe("Element ref (@eN) of the input to type into"),
    text: z.string().describe("Text to type"),
    submit: z.boolean().default(false).describe("Press Enter after typing"),
    includeSnapshot: z.boolean().default(false).describe("Return a fresh snapshot with the result (token-expensive)"),
  },
  handler: async (ctx, args) => {
    const { tabId, ...body } = BrowserTypeRequestSchema.parse(args);
    return ctx.api("POST", ROUTES.browserAct(await resolveTabId(ctx, tabId)), body);
  },
};
