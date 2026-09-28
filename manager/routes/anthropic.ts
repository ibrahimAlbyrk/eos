// Claude credentials routes (Settings › Accounts) — LOOPBACK + ui-token only,
// so an agent holding the daemon URL can't read whether creds are set or write its
// own. Persists { apiKey?, authToken? } to ~/.eos/config.json's `anthropic` key,
// then reloads so the next claude spawn picks it up (the CLI/PTY lane is
// unaffected). GET/PUT both return a REDACTED view — the raw secrets never leave
// the daemon. Mirrors the archive config-write idiom in settings.ts.

import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { constantTimeEqual } from "../shared/constant-time.ts";
import { errMsg } from "../../contracts/src/util.ts";
import { AnthropicConfigSchema, type AnthropicConfig, type AnthropicConfigStatus } from "../../contracts/src/anthropic.ts";
import { ROUTES } from "../../contracts/src/http.ts";
import { patchAnthropicConfig, isCredentialSet } from "../shared/anthropic-config.ts";

// The app-writable slice. .strict() so a typoed key 400s instead of silently
// landing in config.json. A blank value clears the field (see the prune below).
const AnthropicConfigPatchSchema = AnthropicConfigSchema.pick({ apiKey: true, authToken: true }).partial().strict();

function redact(anthropic: AnthropicConfig): AnthropicConfigStatus {
  return { apiKeySet: isCredentialSet(anthropic.apiKey), authTokenSet: isCredentialSet(anthropic.authToken) };
}

export function registerAnthropicRoutes(r: Router, c: Container): void {
  const tokenOk = (req: { headers: Record<string, string | string[] | undefined> }): boolean =>
    constantTimeEqual(req.headers["x-eos-ui-token"], c.uiToken);

  r.get(ROUTES.anthropicConfig, ({ req, res }) => {
    if (!tokenOk(req)) { writeJson(res, 403, { error: "ui token required" }); return; }
    writeJson(res, 200, redact(c.config.anthropic));
  });

  r.put(ROUTES.anthropicConfig, async ({ req, res }) => {
    if (!tokenOk(req)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const patch = validate(AnthropicConfigPatchSchema, await readBody(req));
    try {
      patchAnthropicConfig(c.config.daemon.home, patch);
      c.reloadConfig();
      c.accounts.invalidate();
    } catch (e) {
      writeJson(res, 500, { error: `failed to write config: ${errMsg(e)}` });
      return;
    }
    writeJson(res, 200, redact(c.config.anthropic));
  });
}
