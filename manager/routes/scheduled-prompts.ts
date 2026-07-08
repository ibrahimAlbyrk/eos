import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { CreateScheduledPromptRequestSchema, type ScheduledPromptListResponse } from "../../contracts/src/http.ts";
import { emitScheduledPromptEvent } from "../shared/scheduled-prompt-events.ts";

// Scheduled-prompt CRUD. Creating/cancelling emit a timeline event on the target
// worker (firing is emitted by the SchedulerService itself). The delete route
// cancels ONLY a pending row — a fired/cancelled/unknown id is a clean 404.
export function registerScheduledPromptRoutes(r: Router, c: Container): void {
  r.post("/scheduled-prompts", async ({ req, res }) => {
    const body = validate(CreateScheduledPromptRequestSchema, await readBody(req));
    const row = c.scheduledPrompts.insert({
      id: c.ids.newScheduledPromptId(),
      workerId: body.workerId,
      text: body.text,
      fireAt: body.fireAt,
      createdAt: c.clock.now(),
    });
    emitScheduledPromptEvent(c, "scheduled_prompt:created", row.workerId, row.id, {
      fireAt: row.fireAt,
      text: row.text,
    });
    writeJson(res, 201, row);
  });

  r.get("/scheduled-prompts", ({ url, res }) => {
    const workerId = url.searchParams.get("workerId");
    const items = workerId ? c.scheduledPrompts.listByWorker(workerId) : [];
    const body: ScheduledPromptListResponse = { items };
    writeJson(res, 200, body);
  });

  r.del(/^\/scheduled-prompts\/(?<id>[^/]+)$/, ({ params, res }) => {
    const row = c.scheduledPrompts.findById(params.id);
    if (!c.scheduledPrompts.cancel(params.id)) {
      writeJson(res, 404, { error: "not found or not pending" });
      return;
    }
    if (row) emitScheduledPromptEvent(c, "scheduled_prompt:cancelled", row.workerId, row.id);
    writeJson(res, 200, { ok: true });
  });
}
