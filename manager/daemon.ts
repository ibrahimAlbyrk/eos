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

import { buildContainer } from "./container.ts";
import { Router } from "./routes/Router.ts";
import { mintRequestId } from "./middleware/requestId.ts";
import { handleError, writeJson } from "./middleware/errorHandler.ts";

import { registerHealthRoutes } from "./routes/health.ts";
import { registerStreamRoutes } from "./routes/stream.ts";
import { registerWorkerRoutes } from "./routes/workers.ts";
import { registerOrchestratorRoutes } from "./routes/orchestrators.ts";
import { registerPolicyRoutes } from "./routes/policy.ts";
import { registerPendingRoutes } from "./routes/pending.ts";
import { registerSessionRoutes } from "./routes/session.ts";
import { registerFsRoutes } from "./routes/fs.ts";
import { registerMetricsRoutes } from "./routes/metrics.ts";
import { registerUiConfigRoutes } from "./routes/uiConfig.ts";
import { registerWebRoutes } from "./routes/web.ts";

const c = buildContainer();

const router = new Router();
registerHealthRoutes(router);
registerStreamRoutes(router, c);
// FS + UI routes registered before /workers etc. so the `/web/*` regex
// doesn't accidentally shadow anything. Order matters: first match wins.
registerWebRoutes(router, c);
registerUiConfigRoutes(router, c);
registerMetricsRoutes(router, c);
registerFsRoutes(router, c);
registerWorkerRoutes(router, c);
registerOrchestratorRoutes(router, c);
registerPolicyRoutes(router, c);
registerPendingRoutes(router, c);
registerSessionRoutes(router, c);

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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
});

server.listen(c.config.daemon.port, c.config.daemon.host, () => {
  c.log.info("listening", {
    url: `http://${c.config.daemon.host}:${c.config.daemon.port}`,
    state: c.config.daemon.dbFile,
    logs: c.config.daemon.logDir,
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
