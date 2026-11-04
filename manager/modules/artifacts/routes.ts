// The artifact catalog (contracts/src/artifacts.ts, plan
// docs/artifacts/00-ARTIFACTS-PLAN.md): every claude.ai Artifact of every Eos
// Claude sign-in. The dashboard's only (ui-token) and local-only by route plane:
// it lists this Mac's accounts' work.
//   GET  /api/artifacts          the cached catalog; stale sign-ins re-read in the background
//   POST /api/artifacts/refresh  re-read every sign-in now, answered when done

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Router } from "../../routes/Router.ts";
import { writeJson } from "../../middleware/errorHandler.ts";
import { uiTokenOk } from "../../routes/fs-shared.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import type { ArtifactCatalogService } from "../../../core/src/services/ArtifactCatalogService.ts";

export interface ArtifactRouteDeps {
  readonly artifacts: Pick<ArtifactCatalogService, "get" | "refresh">;
  readonly uiToken: string;
}

export function registerArtifactRoutes(r: Router, c: ArtifactRouteDeps): void {
  const denied = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (uiTokenOk(req, c.uiToken)) return false;
    writeJson(res, 403, { error: "ui token required" });
    return true;
  };

  r.get(ROUTES.artifacts, ({ req, res }) => {
    if (denied(req, res)) return;
    writeJson(res, 200, c.artifacts.get());
  });

  r.post(ROUTES.artifactsRefresh, async ({ req, res }) => {
    if (denied(req, res)) return;
    writeJson(res, 200, await c.artifacts.refresh());
  });
}
