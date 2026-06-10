import type { Router } from "./Router.ts";
import { writeJson } from "../middleware/errorHandler.ts";

export interface HealthInfo {
  pid: number;
  startedAt: number;
  /** Backend source hash computed once at boot — see manager/builder/backend-stamp.ts. */
  sourceStamp: string;
}

export function registerHealthRoutes(r: Router, info: HealthInfo): void {
  r.get("/health", ({ res }) => writeJson(res, 200, { ok: true, ...info }));
}
