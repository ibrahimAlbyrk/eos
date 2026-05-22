import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";

export function registerSessionRoutes(r: Router, c: Container): void {
  r.get("/session", ({ res }) => {
    const counts = c.workers.countActive();
    const cph = c.events.sumDeltaCostSince(c.clock.now() - 60 * 60 * 1000);
    writeJson(res, 200, {
      sessionStartTs: c.workers.earliestOrchestratorStart(),
      totalCost: c.workers.totalCost(),
      costPerHour: cph,
      activeAgents: counts.active,
      totalAgents: counts.total,
      now: c.clock.now(),
    });
  });
}
