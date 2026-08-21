import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";

export const browserTabsDef: ToolDefinition = {
  name: "browser_tabs",
  visibility: "worker",
  inputSchema: {},
  handler: async (ctx) => {
    return ctx.api("GET", ROUTES.browserTabs);
  },
};
