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
import { SignInCodeRequestSchema } from "../../contracts/src/accounts.ts";

const SIGN_IN = /^\/api\/accounts\/(?<provider>[^/]+)\/sign-in$/;
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

  r.post(SIGN_IN, ({ req, res, params }) => {
    if (denied(req, res)) return;
    const provider = decodeURIComponent(params.provider);
    if (!c.signIns.supports(provider)) { writeJson(res, 404, { error: `sign-in is not supported for "${provider}"` }); return; }
    writeJson(res, 202, c.signIns.start(provider));
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
