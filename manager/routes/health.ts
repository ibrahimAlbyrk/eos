import type { Router } from "./Router.ts";
import { writeJson } from "../middleware/errorHandler.ts";

export function registerHealthRoutes(r: Router): void {
  r.get("/health", ({ res }) => writeJson(res, 200, { ok: true }));
}
