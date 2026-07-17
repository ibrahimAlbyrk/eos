// Anthropic credentials routes (Settings > Anthropic) — LOOPBACK + ui-token only,
// so an agent holding the daemon URL can't read whether creds are set or write its
// own. Persists { apiKey?, authToken? } to ~/.eos/config.json's `anthropic` key,
// then reloads so the next claude-sdk spawn picks it up (the CLI/PTY lane is
// unaffected). GET/PUT both return a REDACTED view — the raw secrets never leave
// the daemon. Mirrors the archive config-write idiom in settings.ts.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { constantTimeEqual } from "../shared/constant-time.ts";
import { errMsg } from "../../contracts/src/util.ts";
import { AnthropicConfigSchema, type AnthropicConfig, type AnthropicConfigStatus } from "../../contracts/src/anthropic.ts";
import { ROUTES } from "../../contracts/src/http.ts";

// The app-writable slice. .strict() so a typoed key 400s instead of silently
// landing in config.json. A blank value clears the field (see the prune below).
const AnthropicConfigPatchSchema = AnthropicConfigSchema.pick({ apiKey: true, authToken: true }).partial().strict();

const isSet = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;

function redact(anthropic: AnthropicConfig): AnthropicConfigStatus {
  return { apiKeySet: isSet(anthropic.apiKey), authTokenSet: isSet(anthropic.authToken) };
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
      const path = join(c.config.daemon.home, "config.json");
      const existing = readConfigJson(path);
      const anthropic = existing.anthropic && typeof existing.anthropic === "object"
        ? (existing.anthropic as Record<string, unknown>)
        : {};
      const merged = { ...anthropic, ...patch };
      // A blank field from the UI means "clear it" — drop it so config.json stays
      // clean (the env builder ignores blanks anyway).
      for (const k of ["apiKey", "authToken"] as const) {
        if (!isSet(merged[k])) delete merged[k];
      }
      existing.anthropic = merged;
      writeFileSync(path, JSON.stringify(existing, null, 2));
      c.reloadConfig();
    } catch (e) {
      writeJson(res, 500, { error: `failed to write config: ${errMsg(e)}` });
      return;
    }
    writeJson(res, 200, redact(c.config.anthropic));
  });
}

function readConfigJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
