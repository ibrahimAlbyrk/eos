import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";

export function registerUiConfigRoutes(r: Router, c: Container): void {
  r.get("/api/ui-config", ({ res }) => {
    writeJson(res, 200, {
      models: Object.keys(c.config.prices),
      prices: c.config.prices,
      permissions: { defaultTtlMs: c.config.permissions.defaultTtlMs },
      sse: { keepaliveMs: c.config.daemon.sseKeepaliveMs },
    });
  });
}
