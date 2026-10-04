import type { IncomingMessage, ServerResponse } from "node:http";
import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody, readRawBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { uiTokenOk } from "./fs-shared.ts";
import { StaleProfileError } from "../../core/src/services/UserProfileService.ts";
import { ROUTES } from "../../contracts/src/http.ts";
import {
  AVATAR_MAX_BYTES, UserProfileUpdateRequestSchema, type UserProfilePreview,
} from "../../contracts/src/profile.ts";

const AVATAR_MIME = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const;

// Reads are open (the UI and a controlling Mac render the profile); every write and
// the CLAUDE.md import need the ui-token, so an agent can never rewrite who the user is.
export function registerProfileRoutes(r: Router, c: Container): void {
  const denied = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (uiTokenOk(req, c.uiToken)) return false;
    writeJson(res, 403, { error: "ui token required" });
    return true;
  };

  r.get(ROUTES.profile, ({ res }) => {
    writeJson(res, 200, { profile: c.profile.get() });
  });

  r.put(ROUTES.profile, async ({ req, res }) => {
    if (denied(req, res)) return;
    const body = validate(UserProfileUpdateRequestSchema, await readBody(req));
    try {
      writeJson(res, 200, { profile: c.profile.update(body.patch, body.baseRev) });
    } catch (e) {
      if (e instanceof StaleProfileError) { writeJson(res, 409, { error: e.message, profile: e.profile }); return; }
      throw e;
    }
  });

  // ?kind=<backend kind> (default claude) &project=<abs folder>.
  r.get(ROUTES.profilePreview, ({ url, res }) => {
    const kind = url.searchParams.get("kind") || "claude";
    const block = c.userProfilePreview(kind, url.searchParams.get("project") || null);
    const preview: UserProfilePreview = {
      text: block.text,
      tokens: block.tokens,
      budgetTokens: block.budgetTokens,
      includedMemoryIds: [...block.includedIds],
      overflow: block.overflow,
      withheld: block.withheld,
    };
    writeJson(res, 200, preview);
  });

  // Cache-busted by the client with ?v=<profile rev>.
  r.get(ROUTES.profileAvatar, ({ res }) => {
    const avatar = c.profile.avatar();
    if (!avatar) { writeJson(res, 404, { error: "no avatar" }); return; }
    res.writeHead(200, { "content-type": AVATAR_MIME[avatar.ext], "cache-control": "public, max-age=86400" });
    res.end(avatar.bytes);
  });

  // Raw image bytes (application/octet-stream); the type is sniffed, not declared.
  r.put(ROUTES.profileAvatar, async ({ req, res }) => {
    if (denied(req, res)) return;
    const bytes = await readRawBody(req, AVATAR_MAX_BYTES);
    writeJson(res, 200, { profile: c.profile.setAvatar(bytes) });
  });

  r.del(ROUTES.profileAvatar, ({ req, res }) => {
    if (denied(req, res)) return;
    writeJson(res, 200, { profile: c.profile.clearAvatar() });
  });

  r.get(ROUTES.profileImportClaudeMd, ({ req, res }) => {
    if (denied(req, res)) return;
    writeJson(res, 200, c.readUserClaudeMd());
  });
}
