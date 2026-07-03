import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";

// The backend names the operator actually wrote to ~/.eos/config.json, or null when
// the file is missing/unreadable or declares no `backends`. config.backends is the
// shipped DEFAULT_BACKENDS merged with these, so the on-disk keys are how we tell the
// operator's own profiles from the defaults. null → fresh-install fallback.
export function readOnDiskBackendKeys(path: string): Set<string> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const backends = parsed && typeof parsed === "object" ? (parsed as { backends?: unknown }).backends : null;
    if (!backends || typeof backends !== "object") return null;
    const keys = Object.keys(backends as Record<string, unknown>);
    return keys.length ? new Set(keys) : null;
  } catch {
    return null;
  }
}

// The composer's provider picker should list only the operator's configured
// backends, not the shipped DEFAULT_BACKENDS that config merges in. onDiskKeys is
// the key set from config.json; null/empty keeps the full merged set so a fresh
// install never gets an empty picker.
export function filterBackendProfiles<T extends { name: string }>(
  allProfiles: T[],
  onDiskKeys: Set<string> | null,
): T[] {
  if (!onDiskKeys || onDiskKeys.size === 0) return allProfiles;
  return allProfiles.filter((p) => onDiskKeys.has(p.name));
}

export function registerUiConfigRoutes(r: Router, c: Container): void {
  r.get("/api/ui-config", async ({ res }) => {
    const allProfiles = Object.entries(c.config.backends).map(([name, p]) => ({
      name,
      kind: p.kind,
      model: p.model,
      label: `${name} (${p.model})`,
    }));
    const onDiskKeys = readOnDiskBackendKeys(join(c.config.daemon.home, "config.json"));
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
        // The UI derives "same infrastructure" (live provider-switch grouping)
        // from these two facts, mirroring core's canHandoffBackend.
        sessionStore: d.sessionStore,
        wireDialect: d.wireDialect,
        capabilities: d.capabilities,
      })),
      // Configured named profiles for the composer's profile-lane picker
      // (modelSource:"profile") — name+kind+model+label. Filtered to the operator's
      // own on-disk backends (not the shipped DEFAULT_BACKENDS config merges in).
      backendProfiles: filterBackendProfiles(allProfiles, onDiskKeys),
    });
  });
}
