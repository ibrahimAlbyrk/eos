import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";

import { PolicyDecideRequestSchema } from "../../contracts/src/http.ts";

export function registerPolicyRoutes(r: Router, c: Container): void {
  r.post("/policy/decide", async ({ req, res }) => {
    const body = validate(PolicyDecideRequestSchema, await readBody(req));
    const decision = await c.policyGateway.decide({
      workerId: body.worker_id,
      toolName: body.tool_name,
      input: body.input,
      toolUseId: body.tool_use_id ?? null,
    });
    // The PolicyGateway only ever returns allow|deny to the caller; "ask"
    // is resolved internally via the pending-permissions long-poll.
    writeJson(res, 200, decision);
  });
}
