// Visual answers (contracts/src/genui/spec.ts, plan docs/genui/00-GENUI-PLAN.md):
//   POST /api/genui/views         present — agent plane: an orchestrator or a focused session
//   POST /api/genui/apps          present_app — same callers
//   GET  /api/genui/views/:id     the stored spec (a side-panel tab after a reload)
//   GET  /api/genui/views/:id/state   per-instance UI state
//   PUT  /api/genui/views/:id/state   the dashboard's (ui-token); fans out genui:change
// Media, map, geocode, places and location live in genui-media.ts / location.ts.

import type { IncomingMessage, ServerResponse } from "node:http";

import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { uiTokenOk } from "./fs-shared.ts";
import { agentCallerOf } from "./agent-caller.ts";
import { ROUTES } from "../../contracts/src/http.ts";
import { FOCUSED_ROLE } from "../../contracts/src/worker.ts";
import { GENUI_LIMITS } from "../../contracts/src/genui/catalog.ts";
import {
  CreateAppRequestSchema,
  CreateViewRequestSchema,
  GENUI_TOPICS,
  PutViewStateRequestSchema,
  genuiRejection,
  type GenuiChange,
  type ViewStateResponse,
} from "../../contracts/src/genui/spec.ts";
import { GenuiRejectedError, presentApp, presentView } from "../../core/src/use-cases/PresentView.ts";

const VIEW = /^\/api\/genui\/views\/(?<id>v_[A-Za-z0-9]{12})$/;
const VIEW_STATE = /^\/api\/genui\/views\/(?<id>v_[A-Za-z0-9]{12})\/state$/;
// The state cap plus room for the JSON wrapper.
const STATE_BODY_BYTES = GENUI_LIMITS.stateBytes + 4096;

export function registerGenuiRoutes(r: Router, c: Container): void {
  r.post(ROUTES.genuiViews, async ({ req, res }) => {
    const workerId = presenterOf(c, req);
    if (!workerId) { refusePresenter(res); return; }
    const body = validate(CreateViewRequestSchema, await readBody(req));
    try {
      writeJson(res, 201, presentView(c.genuiPresent, workerId, body.input));
    } catch (e) {
      if (!sendRejection(res, e)) throw e;
    }
  });

  r.post(ROUTES.genuiApps, async ({ req, res }) => {
    const workerId = presenterOf(c, req);
    if (!workerId) { refusePresenter(res); return; }
    const body = validate(CreateAppRequestSchema, await readBody(req));
    try {
      writeJson(res, 201, presentApp(c.genuiPresent, workerId, body.input));
    } catch (e) {
      if (!sendRejection(res, e)) throw e;
    }
  });

  r.get(VIEW, ({ res, params }) => {
    const view = c.genuiViews.get(params.id!);
    if (!view) { viewNotFound(res, params.id!); return; }
    writeJson(res, 200, view);
  });

  r.get(VIEW_STATE, ({ res, params }) => {
    const id = params.id!;
    if (!c.genuiViews.get(id)) { viewNotFound(res, id); return; }
    const stored = c.genuiViews.getState(id);
    const body: ViewStateResponse = { viewId: id, state: stored?.state ?? {}, updatedAt: stored?.updatedAt ?? null };
    writeJson(res, 200, body);
  });

  // Agents read a view's state but never set it: what the user picked is the user's.
  r.put(VIEW_STATE, async ({ req, res, params }) => {
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const id = params.id!;
    const { state } = validate(PutViewStateRequestSchema, await readBody(req, STATE_BODY_BYTES));
    if (!c.genuiViews.get(id)) { viewNotFound(res, id); return; }
    const at = c.clock.now();
    c.genuiViews.putState(id, state, at);
    const change: GenuiChange = { viewId: id, state };
    c.bus.publish(GENUI_TOPICS.change, change);
    const body: ViewStateResponse = { viewId: id, state, updatedAt: at };
    writeJson(res, 200, body);
  });
}

// Who may present: an orchestrator or a focused session — never a spawned
// worker, even by curl (it reports to its orchestrator, which presents).
// Declared, not authenticated, like every agent identity (agent-caller.ts).
function presenterOf(c: Container, req: IncomingMessage): string | null {
  const caller = agentCallerOf(c, req);
  const worker = caller ? c.workers.findById(caller.id) : null;
  if (!worker) return null;
  return worker.is_orchestrator || worker.agent_role === FOCUSED_ROLE ? worker.id : null;
}

function refusePresenter(res: ServerResponse): void {
  writeJson(res, 403, { error: "only an orchestrator or a focused session can present — report to your orchestrator instead" });
}

function viewNotFound(res: ServerResponse, id: string): void {
  writeJson(res, 404, { error: `view not found: ${id}` });
}

function sendRejection(res: ServerResponse, e: unknown): boolean {
  if (!(e instanceof GenuiRejectedError)) return false;
  writeJson(res, 400, genuiRejection(e.problems));
  return true;
}
