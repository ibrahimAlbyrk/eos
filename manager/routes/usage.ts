// Subscription usage route (Settings > Usage). Open read — the
// response carries no secrets (the OAuth token stays server-side), only
// normalized utilization percentages + reset times. The UsageService owns the
// cache + 180s upstream floor, so hitting this on every pane-open / refresh is safe.
// It answers from the held snapshots at once (a stale one refreshes in the
// background, arriving as usage:change); `?wait=1` waits for that refresh.

import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { ROUTES } from "../../contracts/src/http.ts";

export function registerUsageRoutes(r: Router, c: Container): void {
  r.get(ROUTES.usage, async ({ url, res }) => {
    const wait = url.searchParams.get("wait") === "1";
    writeJson(res, 200, await (wait ? c.usage.getUsage() : c.usage.current()));
  });
}
