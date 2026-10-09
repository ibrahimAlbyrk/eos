// GET /api/location — this Mac's position, read by the Eos app (CoreLocation via
// the main window) and labelled with a reverse-geocoded area. Local-only
// (contracts route-planes); 403 unless the user turned location sharing on,
// 503 while the app isn't connected.
//
// Only the dashboard (ui-token) and the agents that hold current_location (an
// orchestrator or a focused session) may read it: a spawned worker or any other
// local process would otherwise borrow Eos's Location Services grant.

import type { IncomingMessage } from "node:http";

import type { Router } from "./Router.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { uiTokenOk } from "./fs-shared.ts";
import { ROUTES } from "../../contracts/src/http.ts";
import { FOCUSED_ROLE } from "../../contracts/src/worker.ts";
import type { LocationSource } from "../../core/src/ports/LocationSource.ts";
import { LocationError } from "../services/genui/media.ts";

interface LocationCaller {
  is_orchestrator?: boolean | number | null;
  agent_role?: string | null;
}

export interface LocationRouteDeps {
  genuiMedia: { location: LocationSource };
  uiToken: string;
  workers: { findById(id: string): LocationCaller | null | undefined };
}

export function registerLocationRoutes(r: Router, c: LocationRouteDeps): void {
  r.get(ROUTES.location, async ({ req, res }) => {
    res.setHeader("cache-control", "no-store");
    if (!mayReadLocation(c, req)) {
      writeJson(res, 403, { error: "location is only for the Eos app, an orchestrator or a focused session", code: "forbidden" });
      return;
    }
    try {
      writeJson(res, 200, await c.genuiMedia.location.current());
    } catch (e) {
      if (!(e instanceof LocationError)) throw e;
      writeJson(res, e.status, { error: e.message, code: e.code });
    }
  });
}

function mayReadLocation(c: LocationRouteDeps, req: IncomingMessage): boolean {
  if (uiTokenOk(req, c.uiToken)) return true;
  const raw = req.headers["x-eos-agent-id"];
  const id = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  const worker = id ? c.workers.findById(id) : null;
  return !!worker && (!!worker.is_orchestrator || worker.agent_role === FOCUSED_ROLE);
}
