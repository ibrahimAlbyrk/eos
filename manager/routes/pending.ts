import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";

import { PendingDecisionRequestSchema } from "../../contracts/src/http.ts";
import { resolvePending } from "../../core/src/use-cases/ResolvePending.ts";

export function registerPendingRoutes(r: Router, c: Container): void {
  r.get("/pending", ({ url, res }) => {
    const rows = c.pending.listUnresolved();
    const parentId = url.searchParams.get("parentId");
    writeJson(res, 200, parentId
      ? rows.filter((p) => c.workers.findById(p.workerId)?.parent_id === parentId)
      : rows);
  });

  r.post(/^\/pending\/(?<id>[^/]+)\/decision$/, async ({ params, req, res }) => {
    const body = validate(PendingDecisionRequestSchema, await readBody(req));
    const result = resolvePending(
      { pending: c.pending, gateway: c.policyGateway },
      { id: params.id, decision: body.decision, reason: body.reason, updatedInput: body.updatedInput },
    );
    writeJson(res, 200, result);
  });
}
