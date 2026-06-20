import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";

import { DynamicLoopRequestSchema } from "../../contracts/src/loop.ts";
import type { DynamicLoopResponse } from "../../contracts/src/loop.ts";
import { attachLoop } from "../../core/src/use-cases/attachLoop.ts";
import { stopLoop } from "../../core/src/use-cases/stopLoop.ts";

// Dynamic-loop attach/stop. Orchestrator-plane, loopback-trusted like the other
// agent-plane routes: the caller is the orchestrator id in the path (:id), and
// the use-cases scope every action to the caller's own loops (confused-deputy
// protection). P1 only persists the loop — nothing drives it yet.
export function registerLoopRoutes(r: Router, c: Container): void {
  r.post(/^\/orchestrators\/(?<id>[^/]+)\/loop$/, async ({ params, req, res }) => {
    const body = validate(DynamicLoopRequestSchema, await readBody(req));
    if (!body.goal) { writeJson(res, 400, { error: "goal required to attach a loop" }); return; }
    // Per-loop args override the global config.loop defaults (core never reads
    // config — the manager passes resolved plain values in). limit may be an
    // explicit null (unbounded), so only fall back when the field is absent.
    const { loopId } = attachLoop(
      { loops: c.loops, workers: c.workers, ids: c.ids, clock: c.clock },
      {
        callerId: params.id,
        target: body.target,
        goal: body.goal,
        strategy: body.strategy ?? (c.config.loop.strategy as "command" | "judge" | "hybrid"),
        // Omitted limit → the config default (null = UNBOUNDED, netted by
        // no-progress); a number caps attempts. An explicit null stays unbounded.
        limit: body.limit === undefined ? c.config.loop.maxAttempts : body.limit,
        enabled: c.config.loop.enabled,
      },
    );
    c.bus.publish("loop:change", { workerId: body.target ?? params.id, status: "active" });
    const response: DynamicLoopResponse = { loopId, status: "active" };
    writeJson(res, 200, response);
  });

  r.post(/^\/orchestrators\/(?<id>[^/]+)\/loop\/stop$/, async ({ params, req, res }) => {
    const body = validate(DynamicLoopRequestSchema, await readBody(req));
    const response: DynamicLoopResponse = stopLoop(
      { loops: c.loops, workers: c.workers },
      { callerId: params.id, target: body.target, loopId: body.loopId },
    );
    const workerId = c.loops.findById(response.loopId)?.workerId;
    if (workerId) c.bus.publish("loop:change", { workerId, status: response.status });
    writeJson(res, 200, response);
  });
}
