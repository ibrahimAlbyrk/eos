import type { IncomingMessage, ServerResponse } from "node:http";
import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { uiTokenOk } from "./fs-shared.ts";
import { agentCallerOf, type AgentCaller } from "./agent-caller.ts";
import { StaleMemoryError } from "../../core/src/services/UserMemoryService.ts";
import { ROUTES } from "../../contracts/src/http.ts";
import {
  UserMemoryCreateRequestSchema, UserMemoryIdSchema, UserMemorySuggestRequestSchema, UserMemoryUpdateRequestSchema,
} from "../../contracts/src/profile.ts";

const ID = "(?<id>um-[a-z0-9]+)";
const MEMORY_PATH = new RegExp(`^/api/user-memories/${ID}$`);
const APPROVE_PATH = new RegExp(`^/api/user-memories/${ID}/approve$`);
const DISMISS_PATH = new RegExp(`^/api/user-memories/${ID}/dismiss$`);
const SEARCH_LIMIT_MAX = 20;

// Agents may only search and suggest; keeping, editing, dismissing and deleting are
// the user's (ui-token). A backend kind the user withholds the profile from is
// refused both, so the memory never reaches that provider by tool either.
export function registerUserMemoryRoutes(r: Router, c: Container): void {
  const denied = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (uiTokenOk(req, c.uiToken)) return false;
    writeJson(res, 403, { error: "ui token required" });
    return true;
  };
  const withheld = (agent: AgentCaller): boolean =>
    agent.kind !== null && c.profile.get().sharing.withholdFrom.includes(agent.kind);

  // Every memory (?status=active|suggested narrows) — the Memory view groups them.
  r.get(ROUTES.userMemories, ({ url, res }) => {
    const status = url.searchParams.get("status");
    const memories = c.userMemories.list().filter((m) => !status || m.status === status);
    writeJson(res, 200, { memories });
  });

  r.post(ROUTES.userMemories, async ({ req, res }) => {
    if (denied(req, res)) return;
    const body = validate(UserMemoryCreateRequestSchema, await readBody(req));
    writeJson(res, 201, { memory: c.userMemories.create(body) });
  });

  r.post(ROUTES.userMemorySuggest, async ({ req, res }) => {
    const agent = agentCallerOf(c, req);
    if (!agent) { writeJson(res, 403, { error: "only an agent can suggest a memory" }); return; }
    if (withheld(agent)) { writeJson(res, 403, { error: "the user doesn't share their profile with this provider" }); return; }
    const body = validate(UserMemorySuggestRequestSchema, await readBody(req));
    if (body.scope === "project" && !agent.project) {
      writeJson(res, 400, { error: "this session has no project folder — suggest it as global" });
      return;
    }
    const result = c.userMemories.suggest(
      {
        text: body.text,
        category: body.category,
        scope: body.scope === "project" ? { kind: "project", path: agent.project! } : { kind: "global" },
      },
      { kind: "agent", agentId: agent.id, agentName: agent.name, ...(body.why ? { why: body.why } : {}) },
    );
    writeJson(res, result.duplicate ? 200 : 201, result);
  });

  // An agent searches its own session's project; the UI names one (?project=).
  r.get(ROUTES.userMemorySearch, ({ req, url, res }) => {
    const agent = agentCallerOf(c, req);
    if (agent && withheld(agent)) { writeJson(res, 403, { error: "the user doesn't share their profile with this provider" }); return; }
    const project = agent ? agent.project : url.searchParams.get("project") || null;
    const limit = Math.min(SEARCH_LIMIT_MAX, Math.max(1, Number(url.searchParams.get("limit")) || 8));
    writeJson(res, 200, { memories: c.userMemories.search(url.searchParams.get("q") ?? "", project, limit) });
  });

  r.post(ROUTES.userMemoriesApproveAll, ({ req, res }) => {
    if (denied(req, res)) return;
    writeJson(res, 200, { memories: c.userMemories.approveAll() });
  });

  r.put(MEMORY_PATH, async ({ req, params, res }) => {
    if (denied(req, res)) return;
    const id = validate(UserMemoryIdSchema, params.id);
    const { baseRev, ...patch } = validate(UserMemoryUpdateRequestSchema, await readBody(req));
    try {
      writeJson(res, 200, { memory: c.userMemories.update(id, patch, baseRev) });
    } catch (e) {
      if (e instanceof StaleMemoryError) { writeJson(res, 409, { error: e.message, memory: e.memory }); return; }
      throw e;
    }
  });

  r.del(MEMORY_PATH, ({ req, params, res }) => {
    if (denied(req, res)) return;
    c.userMemories.remove(validate(UserMemoryIdSchema, params.id));
    writeJson(res, 200, { ok: true });
  });

  r.post(APPROVE_PATH, ({ req, params, res }) => {
    if (denied(req, res)) return;
    writeJson(res, 200, { memory: c.userMemories.approve(validate(UserMemoryIdSchema, params.id)) });
  });

  r.post(DISMISS_PATH, ({ req, params, res }) => {
    if (denied(req, res)) return;
    c.userMemories.dismiss(validate(UserMemoryIdSchema, params.id));
    writeJson(res, 200, { ok: true });
  });
}
