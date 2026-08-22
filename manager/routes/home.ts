import { mkdirSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";

import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";

import { SpawnHomeRequestSchema, MessageRequestSchema } from "../../contracts/src/http.ts";
import { spawnWorker } from "../../core/src/use-cases/SpawnWorker.ts";
import { dispatchMessage } from "../../core/src/use-cases/DispatchMessage.ts";
import { randomOrchestratorName } from "../shared/names.ts";
import { appendSynthesized } from "../shared/synthesized-events.ts";
import { resumeIfDead } from "./resume-helpers.ts";
import { dispatchDeps } from "./dispatch-deps.ts";
import { resolveSpawnBackend, spawnBackendError } from "../shared/spawn-backend.ts";
import { resolveCombinedModel } from "../../core/src/domain/worker-definition-resolution.ts";
import { resolveTier, defaultTierName, CLAUDE_IDENTITY } from "../../core/src/domain/model-tier.ts";
import { archiveWorkerHandler } from "../commands/handlers/archive-worker.ts";
import { purgeWorkerHandler } from "../commands/handlers/purge-worker.ts";

// Home — a Claude-web-style single agent. A root session (no parent, not an
// orchestrator) with role "home": it gets the standard built-in tools but NONE of
// Eos's orchestration MCP tools, and runs in an auto-created private folder
// (~/.eos/home/<id>) rather than a user-picked repo/worktree.
export function registerHomeRoutes(r: Router, c: Container): void {
  r.get("/home", ({ res }) => {
    writeJson(res, 200, c.workers.listHome());
  });

  r.post("/home", async ({ req, res }) => {
    const body = validate(SpawnHomeRequestSchema, await readBody(req));
    const name = (body.name ?? "").trim() || randomOrchestratorName();
    const id = c.ids.newWorkerId();
    // The agent's private workspace — created up front so the session boots inside it.
    const cwd = join(c.config.daemon.home, "home", id);
    mkdirSync(cwd, { recursive: true });

    const split = resolveCombinedModel(body.model, body.backendProfile, new Set(Object.keys(c.config.backends)));
    const explicitProfileName = split.backendProfile;
    const rb = await resolveSpawnBackend(c, { explicitKind: body.backendKind, explicitProfileName, explicitModel: split.model, isOrchestrator: false });
    const backend = c.backends.has(rb.kind) ? c.backends.get(rb.kind) : c.claudeCliBackend;
    const explicit = !!(body.backendKind || explicitProfileName);
    const backendErr = spawnBackendError(backend, rb, explicit);
    if (backendErr) { writeJson(res, 400, { error: backendErr }); return; }

    const result = await spawnWorker(
      {
        workers: c.workers, events: c.events, bus: c.bus,
        supervisor: c.supervisor, ports: c.portAllocator,
        clock: c.clock, ids: c.ids, log: c.log,
        buildArgs: c.buildArgs, buildEnv: c.buildEnv, logFileFor: c.logFileFor,
        backend,
        worktrees: c.worktrees,
        onAgentEvent: c.onAgentEvent,
        recents: c.recents,
        caps: c.modelCatalog,
      },
      {
        prompt: body.prompt ?? "",
        cwd,
        name,
        nameSource: body.name?.trim() ? "user" : "default",
        fixedId: id,
        persistent: true,
        role: "home",
        // Belt-and-suspenders over the empty home control surface: never offer an
        // Eos MCP tool even if a lane composes one in.
        toolScope: { allow: [], deny: ["mcp__orchestrator__*", "mcp__worker__*", "mcp__peer__*"] },
        claudePermissionMode: body.permissionMode ?? "acceptEdits",
        model: resolveTier(
          backend.descriptor.modelSource === "profile"
            ? rb.model
            : (split.model ?? defaultTierName(rb.providerIdentity ?? CLAUDE_IDENTITY)),
          rb.providerIdentity ?? CLAUDE_IDENTITY,
        ),
        effort: body.effort ?? "high",
        isOrchestrator: false,
        backendProfile: rb.profileName ?? undefined,
        providerIdentity: rb.providerIdentity,
        backendAuth: rb.auth,
        backendBaseUrl: rb.baseUrl,
        backendParams: rb.params,
        backendCapabilities: rb.capabilities,
      },
    );
    if (body.prompt) {
      appendSynthesized(c, id, "user_message", { text: body.prompt });
    }
    writeJson(res, 201, { ...result, name });
  });

  r.post(/^\/home\/(?<id>[^/]+)\/message$/, async ({ params, req, res }) => {
    const body = validate(MessageRequestSchema, await readBody(req));
    const target = c.workers.findById(params.id);
    if (target) await resumeIfDead(c, target);
    const result = await dispatchMessage(
      dispatchDeps(c, { excerptLimit: 500 }),
      {
        workerId: params.id, text: body.text,
        clientMsgId: body.clientMsgId, queueWhenBusy: body.queueWhenBusy,
        origin: "dashboard",
      },
    );
    writeJson(res, result.status, result.body);
  });

  // Delete a Home conversation: archive → purge (the dashboard's lifecycle), then
  // soft-trash its private folder so the agent's files are recoverable.
  r.del(/^\/home\/(?<id>[^/]+)$/, async ({ params, res }) => {
    const target = c.workers.findById(params.id);
    if (!target) { writeJson(res, 404, { error: "home session not found" }); return; }
    const ctx = { c, requestId: "home" };
    await archiveWorkerHandler.run({ id: params.id, actorId: undefined }, {}, ctx);
    await purgeWorkerHandler.run({ id: params.id, actorId: undefined }, {}, ctx);
    const dir = join(c.config.daemon.home, "home", params.id);
    if (existsSync(dir)) {
      const trash = join(c.config.daemon.home, ".eos-trash", `home-${params.id}`);
      try { mkdirSync(join(c.config.daemon.home, ".eos-trash"), { recursive: true }); renameSync(dir, trash); }
      catch (e) { c.log.warn("home folder trash failed", { id: params.id, error: e instanceof Error ? e.message : String(e) }); }
    }
    writeJson(res, 200, { ok: true });
  });
}
