// Background jobs (contracts/src/background-job.ts, plan
// docs/background-jobs/00-BACKGROUND-JOBS-PLAN.md). All the dashboard's
// (ui-token): a job's output is a command's output, and stopping it acts on
// another agent's work.
//   GET  /api/jobs                  every job, running first
//   GET  /api/jobs/:id/output       ?since=<offset> — the output after it
//   POST /api/jobs/:id/stop         stop a running job
//   POST /api/jobs/:id/dismiss      drop a finished job
//   POST /api/jobs/clear            drop every finished job

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { uiTokenOk } from "./fs-shared.ts";
import { ROUTES } from "../../contracts/src/http.ts";
import type { BackgroundJobList } from "../../contracts/src/background-job.ts";

const JOB = "(?<id>[A-Za-z0-9_:%.-]+)";
const OUTPUT = new RegExp(`^/api/jobs/${JOB}/output$`);
const STOP = new RegExp(`^/api/jobs/${JOB}/stop$`);
const DISMISS = new RegExp(`^/api/jobs/${JOB}/dismiss$`);

const idOf = (raw: string | undefined): string => {
  try { return decodeURIComponent(raw ?? ""); } catch { return ""; }
};

export function registerJobRoutes(r: Router, c: Container): void {
  const denied = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (uiTokenOk(req, c.uiToken)) return false;
    writeJson(res, 403, { error: "ui token required" });
    return true;
  };

  r.get(ROUTES.jobs, ({ req, res }) => {
    if (denied(req, res)) return;
    const body: BackgroundJobList = { jobs: c.backgroundJobs.list() };
    writeJson(res, 200, body);
  });

  r.get(OUTPUT, ({ req, res, url, params }) => {
    if (denied(req, res)) return;
    const since = Math.max(0, Number.parseInt(url.searchParams.get("since") ?? "0", 10) || 0);
    const out = c.backgroundJobs.output(idOf(params.id), since);
    if (!out) { writeJson(res, 404, { error: "no output for that job" }); return; }
    writeJson(res, 200, out);
  });

  r.post(STOP, async ({ req, res, params }) => {
    if (denied(req, res)) return;
    const result = await c.backgroundJobs.stop(idOf(params.id));
    if (result.ok) writeJson(res, 200, { ok: true });
    else writeJson(res, result.status, { error: result.error });
  });

  r.post(DISMISS, ({ req, res, params }) => {
    if (denied(req, res)) return;
    const result = c.backgroundJobs.dismiss(idOf(params.id));
    if (result.ok) writeJson(res, 200, { ok: true });
    else writeJson(res, result.status, { error: result.error });
  });

  r.post(ROUTES.jobsClear, ({ req, res }) => {
    if (denied(req, res)) return;
    c.backgroundJobs.clearFinished();
    writeJson(res, 200, { ok: true });
  });
}
