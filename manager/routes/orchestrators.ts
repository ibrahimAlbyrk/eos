import { join } from "node:path";
import { homedir } from "node:os";

import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";

import { SpawnOrchestratorRequestSchema, MessageRequestSchema } from "../../contracts/src/http.ts";
import { spawnWorker } from "../../core/src/use-cases/SpawnWorker.ts";
import { dispatchMessage } from "../../core/src/use-cases/DispatchMessage.ts";
import { randomOrchestratorName } from "../container.ts";

function expandPath(p: string | undefined): string | undefined {
  if (!p) return p;
  let out = p.trim();
  if (out.startsWith("~")) {
    const home = process.env.HOME || homedir();
    out = out === "~" || out.startsWith("~/") ? home + out.slice(1) : out;
  }
  return out;
}

export function registerOrchestratorRoutes(r: Router, c: Container): void {
  r.get("/orchestrators", ({ res }) => {
    writeJson(res, 200, c.workers.listOrchestrators());
  });

  r.post("/orchestrators", async ({ req, res }) => {
    const body = validate(SpawnOrchestratorRequestSchema, await readBody(req));
    const name = (body.name ?? "").trim() || randomOrchestratorName();
    const cwd = expandPath(body.cwd);
    const id = c.ids.newOrchestratorId();
    const mcpPath = c.writeOrchestratorMcpConfig(id);
    const result = await spawnWorker(
      {
        workers: c.workers, events: c.events, bus: c.bus,
        supervisor: c.supervisor, ports: c.portAllocator,
        clock: c.clock, ids: c.ids, log: c.log,
        buildArgs: c.buildArgs, buildEnv: c.buildEnv, logFileFor: c.logFileFor,
        onLimitsSet: (id, limits) => c.limitsEnforcer.set(id, limits),
      },
      {
        prompt: "You are now active. Say 'orchestrator ready' and wait for the user's first message.",
        cwd,
        name,
        fixedId: id,
        persistent: true,
        systemPromptFile: join(c.config.paths.repoRoot, "manager", "orchestrator-prompt.md"),
        mcpConfig: mcpPath,
        claudePermissionMode: "bypassPermissions",
        model: body.model ?? "opus",
        isOrchestrator: true,
      },
    );
    writeJson(res, 201, { ...result, name });
  });

  r.post(/^\/orchestrators\/(?<id>[^/]+)\/message$/, async ({ params, req, res }) => {
    const body = validate(MessageRequestSchema, await readBody(req));
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
