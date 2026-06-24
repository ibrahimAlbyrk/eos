import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { StepResultRequestSchema } from "../../contracts/src/workflow.ts";
import type { WorkerSpawnAdapter } from "../services/WorkerSpawnAdapter.ts";

// POST /workers/:id/step-output — the one net-new typed-result IPC path (§3.6). A
// workflow step-worker's submit_step_output lands here: validate the envelope,
// hand the typed object to the run's spawn adapter (which persists it durably and
// resolves the step's PendingJoin — §3.7), and ack. The container phase registers
// the adapter as c.workflowSpawn and mounts this route; until then the access is
// typed through a narrow structural view so this module type-checks standalone.
type WithWorkflowSpawn = Container & { workflowSpawn: WorkerSpawnAdapter };

export function registerWorkflowStepOutputRoute(r: Router, c: Container): void {
  r.post(/^\/workers\/(?<id>[^/]+)\/step-output$/, async ({ params, req, res }) => {
    const body = validate(StepResultRequestSchema, await readBody(req));
    (c as WithWorkflowSpawn).workflowSpawn.resolveStepOutput(params.id, body.output);
    writeJson(res, 200, { ok: true });
  });
}
