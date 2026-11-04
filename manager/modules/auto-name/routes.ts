// Rename-intent signal from the UI: pause the auto-name timer while the rename
// editor is open, resume it if the editor closes without committing. A commit
// goes through PUT /workers/:id/name, which cancels the run. pause/resume on a
// worker with no pending run (not an orchestrator, already named) is a no-op.

import type { Router } from "../../routes/Router.ts";
import { writeJson } from "../../middleware/errorHandler.ts";
import { readBody } from "../../middleware/bodyReader.ts";
import { validate } from "../../middleware/validate.ts";
import { RenameIntentRequestSchema } from "../../../contracts/src/http.ts";

export interface RenameIntentRouteDeps {
  pause(workerId: string): void;
  resume(workerId: string): void;
}

export function registerRenameIntentRoutes(r: Router, deps: RenameIntentRouteDeps): void {
  r.put(/^\/workers\/(?<id>[^/]+)\/rename-intent$/, async ({ params, req, res }) => {
    const body = validate(RenameIntentRequestSchema, await readBody(req));
    if (body.active) deps.pause(params.id);
    else deps.resume(params.id);
    writeJson(res, 200, { ok: true });
  });
}
