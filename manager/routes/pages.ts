import type { IncomingMessage } from "node:http";
import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { uiTokenOk } from "./fs-shared.ts";
import { StalePageError } from "../../core/src/services/PageService.ts";
import { sessionProjectOf, sessionRootOf } from "../../core/src/services/session-root.ts";
import {
  PageCreateRequestSchema, PageEditRequestSchema, PageIdSchema, PageUpdateRequestSchema,
  type PageAuthor,
} from "../../contracts/src/http.ts";

interface PageCaller {
  readonly author: PageAuthor;
  // An agent's own chat + project, the defaults for what it lists and creates.
  readonly session: string | null;
  readonly project: string | null;
}

const USER: PageCaller = { author: { kind: "user", agentId: null, name: null }, session: null, project: null };

// Agents name themselves with x-eos-agent-id (their MCP tools send it); anything
// else is the user's UI. Declared, not authenticated — it attributes edits and
// scopes defaults, it is not an auth boundary.
function callerOf(c: Container, req: IncomingMessage): PageCaller {
  const raw = req.headers["x-eos-agent-id"];
  const id = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  const worker = id ? c.workers.findById(id) : null;
  if (!id || !worker) return USER;
  return {
    author: { kind: "agent", agentId: id, name: worker.name ?? null },
    session: sessionRootOf(c.workers, id),
    project: sessionProjectOf(c.workers, id),
  };
}

const PAGE_PATH = /^\/api\/pages\/(?<id>[^/]+)$/;
const PAGE_EDIT_PATH = /^\/api\/pages\/(?<id>[^/]+)\/edit$/;

// Pages are read and written by agents too, so only delete is UI-token gated.
export function registerPageRoutes(r: Router, c: Container): void {
  // ?project=<abs> one project's pages, ?all=1 every page; with neither, an agent
  // gets its own project's pages and the UI gets everything. ?q= filters by text.
  r.get("/api/pages", ({ req, url, res }) => {
    const caller = callerOf(c, req);
    const projectParam = url.searchParams.get("project");
    const project = url.searchParams.get("all") === "1"
      ? undefined
      : projectParam ?? (caller.project ?? undefined);
    writeJson(res, 200, { pages: c.pages.list({ project, query: url.searchParams.get("q") ?? undefined }) });
  });

  r.get(PAGE_PATH, ({ params, res }) => {
    writeJson(res, 200, { page: c.pages.get(validate(PageIdSchema, params.id)) });
  });

  r.post("/api/pages", async ({ req, res }) => {
    const body = validate(PageCreateRequestSchema, await readBody(req));
    const caller = callerOf(c, req);
    const page = c.pages.create({
      title: body.title,
      body: body.body,
      project: body.project !== undefined ? body.project : caller.project,
      agentId: body.agentId !== undefined ? body.agentId : caller.session,
    }, caller.author);
    writeJson(res, 201, { page });
  });

  r.put(PAGE_PATH, async ({ params, req, res }) => {
    const id = validate(PageIdSchema, params.id);
    const body = validate(PageUpdateRequestSchema, await readBody(req));
    try {
      writeJson(res, 200, { page: c.pages.update(id, body, callerOf(c, req).author) });
    } catch (e) {
      if (e instanceof StalePageError) { writeJson(res, 409, { error: e.message, page: e.page }); return; }
      throw e;
    }
  });

  r.post(PAGE_EDIT_PATH, async ({ params, req, res }) => {
    const id = validate(PageIdSchema, params.id);
    const edit = validate(PageEditRequestSchema, await readBody(req));
    writeJson(res, 200, { page: c.pages.edit(id, edit, callerOf(c, req).author) });
  });

  r.del(PAGE_PATH, ({ params, req, res }) => {
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return; }
    c.pages.remove(validate(PageIdSchema, params.id), USER.author);
    writeJson(res, 200, { ok: true });
  });
}
