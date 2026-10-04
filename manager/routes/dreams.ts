import type { IncomingMessage, ServerResponse } from "node:http";
import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { uiTokenOk } from "./fs-shared.ts";
import { ROUTES } from "../../contracts/src/http.ts";
import { DreamExclusionRequestSchema } from "../../contracts/src/dream.ts";

const RUN_PATH = /^\/api\/dreams\/(?<id>dr-[a-z0-9]+)$/;
const RUNS_LISTED = 30;

// Reads are open (the Memory view, Settings, the log); starting, stopping and
// turning chats off are the user's (ui-token).
export function registerDreamRoutes(r: Router, c: Container): void {
  const denied = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (uiTokenOk(req, c.uiToken)) return false;
    writeJson(res, 403, { error: "ui token required" });
    return true;
  };

  r.get(ROUTES.dreams, ({ res }) => {
    writeJson(res, 200, { runs: c.dreamRepo.list(RUNS_LISTED), excluded: c.dreamRepo.excluded() });
  });

  r.get(ROUTES.dreamStatus, ({ res }) => {
    writeJson(res, 200, c.dreams.status());
  });

  r.get(RUN_PATH, ({ params, res }) => {
    const run = c.dreamRepo.get(params.id ?? "");
    if (!run) { writeJson(res, 404, { error: "no such dream" }); return; }
    writeJson(res, 200, { run });
  });

  // Dream now — runs in the background; progress arrives as dream:change.
  r.post(ROUTES.dreams, ({ req, res }) => {
    if (denied(req, res)) return;
    const r2 = c.dreams.dreamNow();
    writeJson(res, r2.started ? 202 : 409, r2.started ? { started: true } : { error: r2.reason });
  });

  r.post(ROUTES.dreamStop, ({ req, res }) => {
    if (denied(req, res)) return;
    writeJson(res, 200, { stopping: c.dreams.requestStop() });
  });

  r.post(ROUTES.dreamExclusions, async ({ req, res }) => {
    if (denied(req, res)) return;
    const body = validate(DreamExclusionRequestSchema, await readBody(req));
    c.dreamRepo.setExcluded(body.workerId, body.excluded);
    writeJson(res, 200, { excluded: c.dreamRepo.excluded() });
  });
}
