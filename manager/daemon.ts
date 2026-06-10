#!/usr/bin/env node
// Daemon entrypoint — composition root only.
//
// Responsibility split since the redesign:
//   * Adapters (sqlite, child_process, fs, http, pty) live in /infra
//   * Pure domain + use-cases live in /core
//   * Routes (one file per resource) live in ./routes
//   * Composition + wiring lives in ./container.ts
//
// This file just boots the container, mounts routes onto a Router, attaches
// the Router to an HTTP server, and handles process-level signals.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { unlinkSync } from "node:fs";
import { join } from "node:path";

import { buildContainer } from "./container.ts";
import { computeBackendStamp } from "./builder/backend-stamp.ts";
import { Router } from "./routes/Router.ts";
import { mintRequestId } from "./middleware/requestId.ts";
import { handleError, writeJson } from "./middleware/errorHandler.ts";
import { dispatchMessage } from "../core/src/use-cases/DispatchMessage.ts";
import { drainQueuedMessages } from "../core/src/use-cases/DrainQueuedMessages.ts";
import { dispatchDeps } from "./routes/dispatch-deps.ts";

import { registerHealthRoutes } from "./routes/health.ts";
import { registerStreamRoutes } from "./routes/stream.ts";
import { registerWorkerRoutes } from "./routes/workers.ts";
import { registerOrchestratorRoutes } from "./routes/orchestrators.ts";
import { registerPolicyRoutes } from "./routes/policy.ts";
import { registerPendingRoutes } from "./routes/pending.ts";
import { registerFsPickerRoutes } from "./routes/fs-picker.ts";
import { registerFsReadRoutes } from "./routes/fs-read.ts";
import { registerFsGitRoutes } from "./routes/fs-git.ts";
import { registerCommandRoutes } from "./routes/commands.ts";
import { registerTemplateRoutes } from "./routes/templates.ts";
import { registerSettingsRoutes } from "./routes/settings.ts";
import { registerMetricsRoutes } from "./routes/metrics.ts";
import { registerUiConfigRoutes } from "./routes/uiConfig.ts";
import { registerWebRoutes } from "./routes/web.ts";
import { registerFsRawRoutes } from "./routes/fs-raw.ts";

const c = buildContainer();

// Self-stamp once at boot: /health reports the source hash this process
// actually loaded. Never recompute per request — after a source edit an old
// daemon would report the NEW hash and read as falsely fresh.
const sourceStamp = computeBackendStamp(
  c.config.paths.repoRoot,
  join(c.config.daemon.home, "config.json"),
);

const router = new Router();
registerHealthRoutes(router, { pid: process.pid, startedAt: Date.now(), sourceStamp });
registerStreamRoutes(router, c);
// FS + UI routes registered before /workers etc. so the `/web/*` regex
// doesn't accidentally shadow anything. Order matters: first match wins.
registerWebRoutes(router, c);
registerUiConfigRoutes(router, c);
registerMetricsRoutes(router, c);
registerFsPickerRoutes(router, c);
registerFsReadRoutes(router, c);
registerFsGitRoutes(router, c);
registerCommandRoutes(router, c);
registerTemplateRoutes(router, c);
registerSettingsRoutes(router, c);
registerWorkerRoutes(router, c);
registerOrchestratorRoutes(router, c);
registerPolicyRoutes(router, c);
registerPendingRoutes(router, c);

// Queue drain — queued dashboard messages dispatch when their worker reaches
// IDLE. Triggers: every IDLE state transition (payload carries `state`), plus
// the enqueue signal (`queued`) that closes the enqueue/turn-end race. The
// in-flight set keeps bus bursts from double-draining; the use-case re-checks
// state + pending rows itself, so a spurious trigger is a no-op.
const draining = new Set<string>();
c.bus.subscribe("worker:change", (msg) => {
  const p = msg.payload as { workerId?: string; state?: string; queued?: boolean };
  if (!p?.workerId) return;
  if (p.state !== "IDLE" && p.queued !== true) return;
  const workerId = p.workerId;
  if (draining.has(workerId)) return;
  draining.add(workerId);
  void drainQueuedMessages(
    {
      workers: c.workers, queue: c.messageQueue, clock: c.clock, log: c.log,
      clearTurnSettle: (id) => c.turnSettle.clear(id),
      dispatch: (input) => dispatchMessage(dispatchDeps(c), input),
    },
    { workerId },
  )
    .catch((e) => c.log.warn("queue drain error", { workerId, error: e instanceof Error ? e.message : String(e) }))
    .finally(() => draining.delete(workerId));
});

function makeHandler(router: Router) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    c.metrics.requests++;
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const method = req.method ?? "GET";
    const requestId = mintRequestId(req, res, c.ids);

    try {
      const match = router.match(method, url.pathname);
      if (!match) {
        writeJson(res, 404, { error: "not found", path: url.pathname });
        return;
      }
      await match.handler({
        method,
        path: url.pathname,
        url,
        params: match.params,
        req,
        res,
        requestId,
      });
    } catch (e) {
      handleError(res, e, {
        requestId,
        method,
        path: url.pathname,
        log: c.log,
        metrics: c.metrics,
      });
    }
  };
}

const server = createServer(makeHandler(router));

// Raw-content origin: arbitrary disk bytes + the vendored pdf.js viewer on a
// separate port. Viewer iframes run untrusted HTML with `allow-same-origin`,
// so that content must never share an origin with the uiToken-bearing app/API
// server above.
const rawRouter = new Router();
registerFsRawRoutes(rawRouter, c);
const rawServer = createServer(makeHandler(rawRouter));

server.listen(c.config.daemon.port, c.config.daemon.host, () => {
  c.log.info("listening", {
    url: `http://${c.config.daemon.host}:${c.config.daemon.port}`,
    state: c.config.daemon.dbFile,
    logs: c.config.daemon.logDir,
  });
});
rawServer.listen(c.config.daemon.rawPort, c.config.daemon.host, () => {
  c.log.info("raw listening", {
    url: `http://${c.config.daemon.host}:${c.config.daemon.rawPort}`,
  });
});

let shuttingDown = false;
function shutdown(sig: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  const ids = c.supervisor.listIds();
  c.log.info("shutting down", { signal: sig, workers: ids.length });
  for (const id of ids) c.supervisor.escalateKill(id, 0);
  try { unlinkSync(c.config.daemon.pidFile); } catch {}
  try { c.db.close(); } catch {}
  setTimeout(() => process.exit(0), 1500);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Surface but don't crash on async bugs — a SQLite throw inside an exit
// handler or a buggy interval callback used to kill the whole daemon and
// orphan every spawned worker. Logging + continuing is the right default
// for a single-host orchestrator that can recover from transient state.
process.on("uncaughtException", (e: Error) => {
  c.log.error("uncaughtException", { error: e.message, stack: e.stack });
});
process.on("unhandledRejection", (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  c.log.error("unhandledRejection", { reason: msg });
});
