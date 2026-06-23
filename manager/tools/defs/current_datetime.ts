import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";

export const currentDatetimeDef: ToolDefinition = {
  name: "current_datetime",
  visibility: "worker",
  inputSchema: {},
  handler: async (ctx) => {
    // The Clock + TimeZoneProvider live only in the daemon container, so the
    // device date/time is read there (single authoritative source) — every lane
    // reaches it the same way, through ctx.api to the daemon route.
    return ctx.api("GET", ROUTES.datetime);
  },
};
