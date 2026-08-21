import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import { resolveTabId } from "./browser_shared.ts";

export const browserCloseTabDef: ToolDefinition = {
  name: "browser_close_tab",
  visibility: "worker",
  inputSchema: {
    tabId: z.string().optional().describe("Tab to close; omit for the active tab — pass it explicitly when several are open"),
  },
  handler: async (ctx, args) => {
    const tabId = typeof args.tabId === "string" ? args.tabId : undefined;
    return ctx.api("DELETE", ROUTES.browserTab(await resolveTabId(ctx, tabId)));
  },
};
