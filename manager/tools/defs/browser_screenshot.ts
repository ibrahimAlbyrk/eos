import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import { BrowserScreenshotRequestSchema } from "../../../contracts/src/browser.ts";
import { resolveTabId } from "./browser_shared.ts";

export const browserScreenshotDef: ToolDefinition = {
  name: "browser_screenshot",
  visibility: "worker",
  inputSchema: {
    tabId: z.string().optional().describe("Tab to capture; omit for the active tab"),
    fullPage: z.boolean().default(false).describe("Capture the whole page, not just the viewport"),
  },
  handler: async (ctx, args) => {
    const { tabId, ...body } = BrowserScreenshotRequestSchema.parse(args);
    // Returns { path } — the MCP channel is text-only, bytes never come back.
    return ctx.api("POST", ROUTES.browserCapture(await resolveTabId(ctx, tabId)), body);
  },
};
