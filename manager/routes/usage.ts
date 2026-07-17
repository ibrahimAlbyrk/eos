// Subscription usage route (Settings > Usage). Open read like /api/updates/status
// — the response carries no secrets (the OAuth token stays server-side), only
// normalized utilization percentages + reset times. The UsageService owns the
// cache + 180s upstream floor, so hitting this on every pane-open / refresh is safe.

import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { ROUTES } from "../../contracts/src/http.ts";

export function registerUsageRoutes(r: Router, c: Container): void {
  r.get(ROUTES.usage, async ({ res }) => {
    writeJson(res, 200, await c.usage.getUsage());
  });
}
