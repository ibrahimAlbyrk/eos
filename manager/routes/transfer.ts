// File transfer routes (contracts/src/transfer.ts):
//   /transfer/*            this Mac's disk as an endpoint — the Transfer tab lists
//                          through it, and a paired Mac's engine moves bytes with it.
//                          ui-token: from another Mac only as the user (the gateway
//                          attaches it for the device's human dashboard alone).
//   /api/transfers…        this Mac's engine — ui-token, local-only.
//   /workers/:id/transfers a focused agent's send — local-only, locked down.

import type { IncomingMessage, ServerResponse } from "node:http";

import type { Router, RouteContext } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody, readRawBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { uiTokenOk } from "./fs-shared.ts";
import { agentCallerOf } from "./agent-caller.ts";
import { ROUTES } from "../../contracts/src/http.ts";
import { FOCUSED_ROLE } from "../../contracts/src/worker.ts";
import {
  AgentTransferRequestSchema, TRANSFER_MAX_CHUNK, TransferAbortRequestSchema, TransferCommitRequestSchema,
  TransferDecideRequestSchema, TransferDestinationRequestSchema, TransferKeyRequestSchema, TransferLocateRequestSchema,
  TransferPrepareRequestSchema, TransferScanRequestSchema, TransferStartRequestSchema, type TransferErrorCode,
} from "../../contracts/src/transfer.ts";
import { TransferError } from "../../core/src/domain/transfer.ts";

const STATUS: Record<TransferErrorCode, number> = {
  "bad-path": 400, "not-found": 404, "forbidden-dest": 403, "duplicate-name": 409, "too-many": 413,
  "source-changed": 412, "offset-mismatch": 409, "no-space": 507, "conflict-unresolved": 409, "incomplete": 409,
  "unreachable": 502, "needs-update": 501, "forbidden": 403,
};
// A manifest of TRANSFER_MAX_ITEMS entries, with room to spare.
const MANIFEST_BODY_BYTES = 48 * 1024 * 1024;
const ACTION = /^\/api\/transfers\/(?<id>tr-[a-z0-9]+)\/(?<action>pause|resume|cancel|decide)$/;
const AGENT_SEND = /^\/workers\/(?<id>[^/]+)\/transfers$/;
const AGENT_POLL = /^\/workers\/(?<id>[^/]+)\/transfers\/(?<tid>tr-[a-z0-9]+)$/;

export function registerTransferRoutes(r: Router, c: Container): void {
  const ep = c.transferEndpoint;
  // The user's: this Mac's dashboard, or a paired Mac's — vouched for by its gateway.
  const user = (fn: (ctx: RouteContext) => Promise<void>) => async (ctx: RouteContext): Promise<void> => {
    if (!uiTokenOk(ctx.req, c.uiToken)) { writeJson(ctx.res, 403, { error: "ui token required", code: "forbidden" }); return; }
    try {
      await fn(ctx);
    } catch (e) {
      if (!sendTransferError(ctx.res, e)) throw e;
    }
  };

  // ---- endpoint ----------------------------------------------------------------

  r.get(ROUTES.transferList, user(async ({ url, res }) => {
    const path = url.searchParams.get("path") || (await ep.home());
    writeJson(res, 200, await ep.list(path, { hidden: url.searchParams.get("hidden") === "1" }));
  }));

  r.post(ROUTES.transferScan, user(async ({ req, res }) => {
    const body = validate(TransferScanRequestSchema, await readBody(req));
    writeJson(res, 200, await ep.scan(body.paths));
  }));

  r.get(ROUTES.transferRead, user(async ({ url, res }) => {
    const q = url.searchParams;
    const bytes = await ep.read(
      q.get("path") ?? "",
      { offset: int(q.get("offset")), length: int(q.get("length")) },
      { size: int(q.get("size")), mtimeMs: Number(q.get("mtime")) },
    );
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.byteLength });
    res.end(bytes);
  }));

  r.put(ROUTES.transferWrite, user(async ({ url, req, res }) => {
    const q = url.searchParams;
    const data = await readRawBody(req, TRANSFER_MAX_CHUNK);
    const size = await ep.write({ id: q.get("id") ?? "", destDir: q.get("dest") ?? "", rel: q.get("rel") ?? "", offset: int(q.get("offset")) }, data);
    writeJson(res, 200, { size });
  }));

  r.post(ROUTES.transferPrepare, user(async ({ req, res }) => {
    const body = validate(TransferPrepareRequestSchema, await readBody(req, MANIFEST_BODY_BYTES));
    writeJson(res, 200, await ep.prepare(body));
  }));

  r.post(ROUTES.transferCommit, user(async ({ req, res }) => {
    const body = validate(TransferCommitRequestSchema, await readBody(req));
    writeJson(res, 200, await ep.commit(body));
  }));

  r.post(ROUTES.transferAbort, user(async ({ req, res }) => {
    await ep.abort(validate(TransferAbortRequestSchema, await readBody(req)));
    writeJson(res, 200, { ok: true });
  }));

  r.post(ROUTES.transferKey, user(async ({ req, res }) => {
    const body = validate(TransferKeyRequestSchema, await readBody(req));
    writeJson(res, 200, { key: await ep.projectKey(body.path) });
  }));

  r.post(ROUTES.transferLocate, user(async ({ req, res }) => {
    const body = validate(TransferLocateRequestSchema, await readBody(req));
    writeJson(res, 200, { path: await ep.locate(body.key) });
  }));

  // ---- this Mac's engine ---------------------------------------------------------

  r.get(ROUTES.transfers, user(async ({ res }) => {
    writeJson(res, 200, { transfers: c.transfers.list() });
  }));

  r.post(ROUTES.transfers, user(async ({ req, res }) => {
    const body = validate(TransferStartRequestSchema, await readBody(req));
    writeJson(res, 201, await c.transfers.start(body));
  }));

  r.del(ROUTES.transfers, user(async ({ res }) => {
    writeJson(res, 200, { removed: c.transfers.clearFinished() });
  }));

  r.post(ROUTES.transferDestination, user(async ({ req, res }) => {
    const body = validate(TransferDestinationRequestSchema, await readBody(req));
    writeJson(res, 200, await c.transfers.destination(body.from, body.to, body.paths));
  }));

  r.post(ACTION, user(async ({ req, res, params }) => {
    const id = params.id!;
    if (params.action === "decide") {
      const body = validate(TransferDecideRequestSchema, await readBody(req));
      writeJson(res, 200, c.transfers.decide(id, body.decisions));
      return;
    }
    const t = params.action === "pause" ? c.transfers.pause(id) : params.action === "resume" ? c.transfers.resume(id) : c.transfers.cancel(id);
    writeJson(res, 200, t);
  }));

  // ---- a focused agent sending files ----------------------------------------------

  r.post(AGENT_SEND, async ({ req, res, params }) => {
    const worker = focusedCaller(c, req, params.id!);
    if (!worker) { refuseAgent(res); return; }
    const body = validate(AgentTransferRequestSchema, await readBody(req));
    try {
      writeJson(res, 201, await c.transfers.sendForAgent({ id: worker.id, name: worker.name ?? worker.id, cwd: worker.worktree_dir ?? worker.cwd }, body));
    } catch (e) {
      if (!sendTransferError(res, e)) throw e;
    }
  });

  r.get(AGENT_POLL, ({ req, res, params }) => {
    if (!focusedCaller(c, req, params.id!)) { refuseAgent(res); return; }
    const t = c.transfers.get(params.tid!);
    if (t.origin.agentId !== params.id) { writeJson(res, 404, { error: "not one of your transfers" }); return; }
    writeJson(res, 200, t);
  });
}

// The agent asking is the one in the path, and it's a focused session — the
// one the user talks to directly. Declared, not authenticated: what it may do
// is fenced by the engine (this Mac → ~/Downloads/Eos there, nothing replaced).
function focusedCaller(c: Container, req: IncomingMessage, id: string) {
  const caller = agentCallerOf(c, req);
  const worker = caller?.id === id ? c.workers.findById(id) : null;
  return worker?.agent_role === FOCUSED_ROLE ? worker : null;
}

function refuseAgent(res: ServerResponse): void {
  writeJson(res, 403, { error: "only a focused session can send files to another Mac" });
}

function sendTransferError(res: ServerResponse, e: unknown): boolean {
  if (!(e instanceof TransferError)) return false;
  writeJson(res, STATUS[e.code], { error: e.message, code: e.code, ...(e.have !== undefined ? { have: e.have } : {}) });
  return true;
}

function int(v: string | null): number {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : -1;
}
