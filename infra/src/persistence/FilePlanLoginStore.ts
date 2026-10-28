// FilePlanLoginStore — the plan sign-in registry as one JSON file
// (~/.eos/accounts/logins.json, 0600). It holds no credential, only where each
// one is stored. Invalid entries are dropped rather than failing the whole file.

import { existsSync, readFileSync } from "node:fs";
import type { PlanLoginStore } from "../../../core/src/ports/PlanLoginStore.ts";
import { EMPTY_PLAN_LOGINS, type PlanLoginRecord, type PlanLoginRegistry } from "../../../core/src/domain/plan-logins.ts";
import { writeFileAtomic } from "./atomic-file.ts";

const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function parseLogin(v: unknown): PlanLoginRecord | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (!isText(r.id) || !isText(r.provider) || !isText(r.label) || !isText(r.storeDir) || !isText(r.createdAt)) return null;
  return {
    id: r.id, provider: r.provider, label: r.label, storeDir: r.storeDir, createdAt: r.createdAt,
    ...(isText(r.email) ? { email: r.email } : {}),
  };
}

export function parsePlanLogins(raw: unknown): PlanLoginRegistry {
  if (!raw || typeof raw !== "object") return EMPTY_PLAN_LOGINS;
  const r = raw as Record<string, unknown>;
  const logins = Array.isArray(r.logins) ? r.logins.flatMap((l) => parseLogin(l) ?? []) : [];
  const defaults = r.defaults && typeof r.defaults === "object"
    ? Object.fromEntries(Object.entries(r.defaults).filter(([, id]) => isText(id) && logins.some((l) => l.id === id)))
    : {};
  const autoSwitch = r.autoSwitch && typeof r.autoSwitch === "object"
    ? Object.fromEntries(Object.entries(r.autoSwitch).filter(([, on]) => typeof on === "boolean"))
    : {};
  return {
    logins,
    defaults: defaults as Record<string, string>,
    ...(Object.keys(autoSwitch).length ? { autoSwitch: autoSwitch as Record<string, boolean> } : {}),
  };
}

export class FilePlanLoginStore implements PlanLoginStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  load(): PlanLoginRegistry {
    try {
      return existsSync(this.file) ? parsePlanLogins(JSON.parse(readFileSync(this.file, "utf8"))) : EMPTY_PLAN_LOGINS;
    } catch {
      return EMPTY_PLAN_LOGINS;
    }
  }

  save(reg: PlanLoginRegistry): void {
    writeFileAtomic(this.file, JSON.stringify({ v: 1, ...reg }, null, 2), 0o600);
  }
}
