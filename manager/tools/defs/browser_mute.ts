import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import { BrowserMuteRequestSchema } from "../../../contracts/src/browser.ts";
import { resolveTabId } from "./browser_shared.ts";

export const browserMuteDef: ToolDefinition = {
  name: "browser_mute",
  visibility: "worker",
  inputSchema: {
    tabId: z.string().optional().describe("Tab to mute; omit for the active tab"),
    muted: z.boolean().describe("true silences the tab, false restores audio"),
  },
  handler: async (ctx, args) => {
    const { tabId, ...body } = BrowserMuteRequestSchema.parse(args);
    return ctx.api("POST", ROUTES.browserMute(await resolveTabId(ctx, tabId)), body);
  },
};
