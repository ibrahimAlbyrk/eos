// Accounts routes (Settings › Accounts) — LOOPBACK + ui-token only, so an agent
// holding the daemon URL can neither read account state nor sign the user in or
// out. Every response is redacted (contracts/src/accounts.ts). API keys are NOT
// written here: Claude's goes through /api/anthropic/config and a preset's through
// /api/backends, which already own those stores.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { uiTokenOk } from "./fs-shared.ts";
import { errMsg } from "../../contracts/src/util.ts";
import { ROUTES } from "../../contracts/src/http.ts";
import {
  AutoSwitchRequestSchema, DefaultLoginRequestSchema, PlanLoginRenameRequestSchema, PlanResumeRequestSchema,
  SignInCodeRequestSchema, SignInStartRequestSchema,
} from "../../contracts/src/accounts.ts";

const SIGN_IN = /^\/api\/accounts\/(?<provider>[^/]+)\/sign-in$/;
const LOGIN = /^\/api\/accounts\/(?<provider>[^/]+)\/logins\/(?<id>[^/]+)$/;
const DEFAULT_LOGIN = /^\/api\/accounts\/(?<provider>[^/]+)\/default-login$/;
const AUTO_SWITCH = /^\/api\/accounts\/(?<provider>[^/]+)\/auto-switch$/;
const PLAN_RESUME = /^\/workers\/(?<id>[^/]+)\/plan-resume$/;
const API_KEY_CONTINUE = /^\/workers\/(?<id>[^/]+)\/api-key-continue$/;
const SESSION = /^\/api\/sign-ins\/(?<id>[^/]+)$/;
const SESSION_CODE = /^\/api\/sign-ins\/(?<id>[^/]+)\/code$/;

export function registerAccountRoutes(r: Router, c: Container): void {
  const denied = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (uiTokenOk(req, c.uiToken)) return false;
    writeJson(res, 403, { error: "ui token required" });
    return true;
  };

  r.get(ROUTES.accounts, async ({ req, res }) => {
    if (denied(req, res)) return;
    writeJson(res, 200, { accounts: await c.accounts.list() });
  });

  // The provider named in the path, when it holds several sign-ins; else a 404.
  const severalOf = (res: ServerResponse, raw: string): string | null => {
    const provider = decodeURIComponent(raw);
    if (c.signIns.holdsSeveral(provider)) return provider;
    writeJson(res, 404, { error: `"${provider}" holds a single sign-in` });
    return null;
  };

  r.post(SIGN_IN, async ({ req, res, params }) => {
    if (denied(req, res)) return;
    const provider = decodeURIComponent(params.provider);
    if (!c.signIns.supports(provider)) { writeJson(res, 404, { error: `sign-in is not supported for "${provider}"` }); return; }
    const { loginId } = validate(SignInStartRequestSchema, await readBody(req));
    writeJson(res, 202, c.signIns.start(provider, { loginId }));
  });

  r.put(LOGIN, async ({ req, res, params }) => {
    if (denied(req, res)) return;
    const provider = severalOf(res, params.provider);
    if (!provider) return;
    const { label } = validate(PlanLoginRenameRequestSchema, await readBody(req));
    c.loginRegistry.rename(provider, decodeURIComponent(params.id), label);
    writeJson(res, 200, { ok: true });
  });

  r.del(LOGIN, async ({ req, res, params }) => {
    if (denied(req, res)) return;
    const provider = severalOf(res, params.provider);
    if (!provider) return;
    await c.signIns.removeLogin(provider, decodeURIComponent(params.id));
    writeJson(res, 200, { ok: true });
  });

  r.put(DEFAULT_LOGIN, async ({ req, res, params }) => {
    if (denied(req, res)) return;
    const provider = severalOf(res, params.provider);
    if (!provider) return;
    const { loginId } = validate(DefaultLoginRequestSchema, await readBody(req));
    c.loginRegistry.setDefault(provider, loginId);
    writeJson(res, 200, { ok: true });
  });

  r.put(AUTO_SWITCH, async ({ req, res, params }) => {
    if (denied(req, res)) return;
    const provider = severalOf(res, params.provider);
    if (!provider) return;
    const { enabled } = validate(AutoSwitchRequestSchema, await readBody(req));
    c.loginRegistry.setAutoSwitch(provider, enabled);
    writeJson(res, 200, { ok: true });
  });

  r.del(SIGN_IN, async ({ req, res, params }) => {
    if (denied(req, res)) return;
    const provider = decodeURIComponent(params.provider);
    if (!c.signIns.supports(provider)) { writeJson(res, 404, { error: `sign-in is not supported for "${provider}"` }); return; }
    try {
      await c.signIns.signOut(provider);
    } catch (e) {
      writeJson(res, 500, { error: `failed to sign out: ${errMsg(e)}` });
      return;
    }
    writeJson(res, 200, { ok: true });
  });

  // An accounts_exhausted row's actions.
  r.put(PLAN_RESUME, async ({ req, res, params }) => {
    if (denied(req, res)) return;
    const { rowId, on } = validate(PlanResumeRequestSchema, await readBody(req));
    const workerId = decodeURIComponent(params.id);
    if (!on) { c.planResume.cancel(workerId, rowId); writeJson(res, 200, { ok: true }); return; }
    const r2 = c.planResume.schedule(workerId, rowId);
    writeJson(res, r2.ok ? 200 : 409, r2.ok ? { ok: true } : { error: r2.error });
  });

  r.post(API_KEY_CONTINUE, async ({ req, res, params }) => {
    if (denied(req, res)) return;
    const r2 = await c.continueWorkerOnApiKey(decodeURIComponent(params.id));
    writeJson(res, r2.ok ? 200 : 409, r2.ok ? { ok: true } : { error: r2.error });
  });

  r.get(SESSION, ({ req, res, params }) => {
    if (denied(req, res)) return;
    const session = c.signIns.get(params.id);
    if (!session) { writeJson(res, 404, { error: "sign-in not found" }); return; }
    writeJson(res, 200, session);
  });

  r.del(SESSION, ({ req, res, params }) => {
    if (denied(req, res)) return;
    writeJson(res, c.signIns.cancel(params.id) ? 200 : 404, c.signIns.get(params.id) ?? { error: "sign-in not found" });
  });

  r.post(SESSION_CODE, async ({ req, res, params }) => {
    if (denied(req, res)) return;
    const { code } = validate(SignInCodeRequestSchema, await readBody(req));
    if (!c.signIns.submitCode(params.id, code)) { writeJson(res, 409, { error: "sign-in is not waiting for a code" }); return; }
    writeJson(res, 200, c.signIns.get(params.id));
  });
}
