import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";

import { homedir } from "node:os";

import {
  SpawnWorkerRequestSchema,
  EventsQuerySchema,
  MessageRequestSchema,
} from "../../contracts/src/http.ts";

import { spawnWorker } from "../../core/src/use-cases/SpawnWorker.ts";
import { killWorker } from "../../core/src/use-cases/KillWorker.ts";
import { dispatchMessage } from "../../core/src/use-cases/DispatchMessage.ts";
import { processWorkerEvent } from "../../core/src/use-cases/ProcessWorkerEvent.ts";

function expandPath(p: string | undefined): string | undefined {
  if (!p) return p;
  let out = p.trim();
  if (out.startsWith("~")) {
    const home = process.env.HOME || homedir();
    out = out === "~" || out.startsWith("~/") ? home + out.slice(1) : out;
  }
  return out;
}

export function registerWorkerRoutes(r: Router, c: Container): void {
  r.get("/workers", ({ res }) => {
    writeJson(res, 200, c.workers.listAll());
  });

  r.post("/workers", async ({ req, res }) => {
    const raw = await readBody(req);
    const body = validate(SpawnWorkerRequestSchema, raw);
    // Normalize tilde paths upstream so use-cases see absolute paths only.
    const spec = {
      ...body,
      cwd: expandPath(body.cwd),
      worktreeFrom: expandPath(body.worktreeFrom),
    };
    const result = await spawnWorker(
      {
        workers: c.workers,
        events: c.events,
        bus: c.bus,
        supervisor: c.supervisor,
        ports: c.portAllocator,
        clock: c.clock,
        ids: c.ids,
        log: c.log,
        buildArgs: c.buildArgs,
        buildEnv: c.buildEnv,
        logFileFor: c.logFileFor,
        onLimitsSet: (id, limits) => c.limitsEnforcer.set(id, limits),
      },
      spec,
    );
    writeJson(res, 201, result);
  });

  r.get(/^\/workers\/(?<id>[^/]+)$/, ({ params, res }) => {
    const row = c.workers.findById(params.id);
    if (!row) { writeJson(res, 404, { error: "not found" }); return; }
    writeJson(res, 200, row);
  });

  r.del(/^\/workers\/(?<id>[^/]+)$/, ({ params, res }) => {
    const supervisorWithFind = c.supervisor as ReturnType<typeof import("../../infra/src/supervision/ChildProcessSupervisor.ts").createChildProcessSupervisor>;
    const result = killWorker(
      {
        workers: c.workers,
        events: c.events,
        pending: c.pending,
        bus: c.bus,
        supervisor: c.supervisor,
        log: c.log,
        findOrphanPids: (safeName) => supervisorWithFind.findPidsByPattern(`cm-${safeName}-`),
        postKillCleanup: (id) => {
          c.limitsEnforcer.clear(id);
          c.cleanupOrchestratorMcpConfig(id);
        },
      },
      params.id,
    );
    writeJson(res, 200, { killed: result.killed, removed: result.removed, was_state: result.wasState });
  });

  r.get(/^\/workers\/(?<id>[^/]+)\/events$/, ({ params, url, res }) => {
    const q = validate(EventsQuerySchema, {
      since: url.searchParams.get("since") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      order: url.searchParams.get("order") ?? undefined,
    });
    const rows = c.events.list({ workerId: params.id, since: q.since, limit: q.limit, order: q.order });
    writeJson(res, 200, rows);
  });

  r.post(/^\/workers\/(?<id>[^/]+)\/events$/, async ({ params, req, res }) => {
    const body = await readBody(req) as { type?: string; payload?: unknown };
    if (!body.type) { writeJson(res, 400, { error: "type required" }); return; }
    processWorkerEvent(
      {
        workers: c.workers, events: c.events, bus: c.bus,
        clock: c.clock, models: c.models, log: c.log,
        onUsageRecorded: (id) => c.limitsEnforcer.check(id),
      },
      { workerId: params.id, type: body.type, payload: body.payload },
    );
    writeJson(res, 200, { ok: true });
  });

  r.post(/^\/workers\/(?<id>[^/]+)\/message$/, async ({ params, req, res }) => {
    const body = validate(MessageRequestSchema, await readBody(req));
    const result = await dispatchMessage(
      {
        workers: c.workers, events: c.events, bus: c.bus, clock: c.clock,
        client: c.httpWorkerClient, log: c.log,
        isLive: (id) => c.supervisor.has(id),
        excerptLimit: 200,
      },
      { workerId: params.id, text: body.text },
    );
    writeJson(res, result.status, result.body);
  });
}
