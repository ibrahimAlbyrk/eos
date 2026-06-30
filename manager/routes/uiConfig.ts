import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";

export function registerUiConfigRoutes(r: Router, c: Container): void {
  r.get("/api/ui-config", async ({ res }) => {
    writeJson(res, 200, {
      models: Object.keys(c.config.prices),
      modelCatalog: await c.modelCatalog.get(),
      prices: c.config.prices,
      permissions: { defaultTtlMs: c.config.permissions.defaultTtlMs },
      sse: { keepaliveMs: c.config.daemon.sseKeepaliveMs },
      backends: c.backends.descriptors().map((d) => ({
        kind: d.kind,
        label: d.label,
        enabled: d.enabled,
        billing: d.billing,
        capabilities: d.capabilities,
      })),
      // Configured named profiles for the composer's profile-lane picker
      // (modelSource:"profile") — name+kind+model+label.
      backendProfiles: Object.entries(c.config.backends).map(([name, p]) => ({
        name,
        kind: p.kind,
        model: p.model,
        label: `${name} (${p.model})`,
      })),
    });
  });
}
