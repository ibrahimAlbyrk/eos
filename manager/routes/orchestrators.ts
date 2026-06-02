import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";

import { SpawnOrchestratorRequestSchema, MessageRequestSchema } from "../../contracts/src/http.ts";
import { spawnWorker } from "../../core/src/use-cases/SpawnWorker.ts";
import { dispatchMessage } from "../../core/src/use-cases/DispatchMessage.ts";
import { randomOrchestratorName } from "../shared/names.ts";
import { expandPath } from "../shared/path.ts";

export function registerOrchestratorRoutes(r: Router, c: Container): void {
  r.get("/orchestrators", ({ res }) => {
    writeJson(res, 200, c.workers.listOrchestrators());
  });

  r.post("/orchestrators", async ({ req, res }) => {
    const body = validate(SpawnOrchestratorRequestSchema, await readBody(req));
    const name = (body.name ?? "").trim() || randomOrchestratorName();
    const cwd = expandPath(body.cwd);
    const id = c.ids.newOrchestratorId();
    const result = await spawnWorker(
      {
        workers: c.workers, events: c.events, bus: c.bus,
        supervisor: c.supervisor, ports: c.portAllocator,
        clock: c.clock, ids: c.ids, log: c.log,
        buildArgs: c.buildArgs, buildEnv: c.buildEnv, logFileFor: c.logFileFor,
        recents: c.recents,
      },
      {
        prompt: body.prompt ?? "",
        cwd,
        name,
        fixedId: id,
        persistent: true,
        systemPromptFile: c.config.paths.orchestratorPromptFile,
        claudePermissionMode: body.permissionMode ?? "default",
        model: body.model ?? "opus",
        effort: body.effort ?? "high",
        isOrchestrator: true,
      },
    );
    if (body.prompt) {
      c.events.append(id, c.clock.now(), "user_message", { text: body.prompt });
      c.bus.publish("worker:change", { workerId: id });
    }
    writeJson(res, 201, { ...result, name });
  });

  r.post(/^\/orchestrators\/(?<id>[^/]+)\/message$/, async ({ params, req, res }) => {
    const body = validate(MessageRequestSchema, await readBody(req));
    c.turnSettle.clear(params.id);
    const result = await dispatchMessage(
      {
        workers: c.workers, events: c.events, bus: c.bus, clock: c.clock,
        client: c.httpWorkerClient, log: c.log,
        isLive: (id) => c.supervisor.has(id),
        requireOrchestrator: true,
        excerptLimit: 500,
      },
      { workerId: params.id, text: body.text },
    );
    writeJson(res, result.status, result.body);
  });
}
