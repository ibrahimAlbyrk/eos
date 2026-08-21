import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import { BrowserSnapshotRequestSchema } from "../../../contracts/src/browser.ts";
import { resolveTabId } from "./browser_shared.ts";

export const browserSnapshotDef: ToolDefinition = {
  name: "browser_snapshot",
  visibility: "worker",
  inputSchema: {
    tabId: z.string().optional().describe("Tab to read; omit for the active tab"),
    interactiveOnly: z.boolean().default(true).describe("Only interactive elements (buttons, links, inputs) — keeps the tree small"),
    selector: z.string().optional().describe("Scope the tree to a CSS-selector subtree"),
    depth: z.number().int().positive().optional().describe("Limit tree depth"),
  },
  handler: async (ctx, args) => {
    const { tabId, ...body } = BrowserSnapshotRequestSchema.parse(args);
    return ctx.api("POST", ROUTES.browserSnapshot(await resolveTabId(ctx, tabId)), body);
  },
};
