import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import { BrowserWaitRequestSchema } from "../../../contracts/src/browser.ts";
import { resolveTabId } from "./browser_shared.ts";

export const browserWaitDef: ToolDefinition = {
  name: "browser_wait",
  visibility: "worker",
  inputSchema: {
    tabId: z.string().optional().describe("Tab to watch; omit for the active tab"),
    forText: z.string().optional().describe("Wait until this text appears on the page (substring)"),
    forRef: z.string().optional().describe("Wait until this element ref (@eN) is visible"),
    forMs: z.number().int().positive().optional().describe("Wait a fixed number of milliseconds"),
    timeoutMs: z.number().int().positive().default(15000).describe("Give up after this long"),
  },
  handler: async (ctx, args) => {
    const { tabId, ...body } = BrowserWaitRequestSchema.parse(args);
    return ctx.api("POST", ROUTES.browserWait(await resolveTabId(ctx, tabId)), body);
  },
};
