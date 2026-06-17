import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";

import { SpawnOrchestratorRequestSchema, MessageRequestSchema } from "../../contracts/src/http.ts";
import { spawnWorker } from "../../core/src/use-cases/SpawnWorker.ts";
import { dispatchMessage } from "../../core/src/use-cases/DispatchMessage.ts";
import { meteredNeedsBilledIntent } from "../../core/src/domain/backend-billing.ts";
import { randomOrchestratorName } from "../shared/names.ts";
import { expandPath } from "../shared/path.ts";
import { appendSynthesized } from "../shared/synthesized-events.ts";
import { resumeIfDead } from "./resume-helpers.ts";
import { dispatchDeps } from "./dispatch-deps.ts";
import { resolveSpawnBackend } from "../shared/spawn-backend.ts";

export function registerOrchestratorRoutes(r: Router, c: Container): void {
  r.get("/orchestrators", ({ res }) => {
    writeJson(res, 200, c.workers.listOrchestrators());
  });

  r.post("/orchestrators", async ({ req, res }) => {
    const body = validate(SpawnOrchestratorRequestSchema, await readBody(req));
    const name = (body.name ?? "").trim() || randomOrchestratorName();
    const cwd = expandPath(body.cwd);
    const id = c.ids.newOrchestratorId();
    const rb = await resolveSpawnBackend(c, { explicitProfileName: body.backendProfile, isOrchestrator: true });
    // Billing guard: an explicitly-selected metered-API profile must opt into
    // per-token charges (costMode:"billed"); subscription kinds are exempt.
    if (body.backendProfile && meteredNeedsBilledIntent(rb)) {
      writeJson(res, 400, { error: `backend "${rb.profileName ?? rb.kind}" is a metered API — set its profile costMode:"billed" to opt into per-token charges` });
      return;
    }
    const backend = c.backends.has(rb.kind) ? c.backends.get(rb.kind) : c.claudeCliBackend;
    const result = await spawnWorker(
      {
        workers: c.workers, events: c.events, bus: c.bus,
        supervisor: c.supervisor, ports: c.portAllocator,
        clock: c.clock, ids: c.ids, log: c.log,
        buildArgs: c.buildArgs, buildEnv: c.buildEnv, logFileFor: c.logFileFor,
        backend,
        onAgentEvent: c.onAgentEvent,
        recents: c.recents,
        caps: c.modelCatalog,
      },
      {
        prompt: body.prompt ?? "",
        cwd,
        name,
        fixedId: id,
        persistent: true,
        claudePermissionMode: body.permissionMode ?? "acceptEdits",
        // Lane B (deepseek/kimi/openai) carries its own model; claude-sdk + claude-cli
        // run the user-picked Claude model.
        model: rb.kind !== "claude-cli" && rb.kind !== "claude-sdk" ? rb.model : (body.model ?? "opus"),
        effort: body.effort ?? "xhigh",
        isOrchestrator: true,
        backendProfile: rb.profileName ?? undefined,
      },
    );
    if (body.prompt) {
      appendSynthesized(c, id, "user_message", { text: body.prompt });
    }
    writeJson(res, 201, { ...result, name });
  });

  r.post(/^\/orchestrators\/(?<id>[^/]+)\/message$/, async ({ params, req, res }) => {
    const body = validate(MessageRequestSchema, await readBody(req));
    const target = c.workers.findById(params.id);
    if (target) await resumeIfDead(c, target);
    const result = await dispatchMessage(
      dispatchDeps(c, { requireOrchestrator: true, excerptLimit: 500 }),
      {
        workerId: params.id, text: body.text,
        clientMsgId: body.clientMsgId, queueWhenBusy: body.queueWhenBusy,
        origin: "dashboard",
      },
    );
    writeJson(res, result.status, result.body);
  });
}
