import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { currentDateTime } from "../../core/src/use-cases/CurrentDateTime.ts";

// GET /datetime — the device's current date+time, read from the container's
// injected Clock + TimeZoneProvider (the single authoritative source). The
// current_datetime tool on every lane routes here via ctx.api.
export function registerDatetimeRoutes(r: Router, c: Container): void {
  r.get("/datetime", ({ res }) => {
    writeJson(res, 200, currentDateTime(c.clock, c.timeZone));
  });
}
