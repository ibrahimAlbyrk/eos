// Control ↔ REST capability tiers (§5.2.3). A remote control{method,path} is
// classified here BEFORE it is dispatched into the real route handler. The ONLY
// tier that gates dispatch in v3 is REFUSED (never remote-reachable). READ / LOW /
// HIGH survive as route classification (audit + a stable map) but no longer imply
// a step-up — every joined device is dispatched at full capability (§5.1).
//   READ    — pure reads
//   LOW     — non-RCE mutations
//   HIGH    — RCE / externally-visible (dispatched, not step-up-gated in v3)
//   REFUSED — never dispatched remotely (worker-ingest plane, raw server, pickers)
// Unknown (method,path) FAILS CLOSED to REFUSED. `uiToken: true` marks the ✦
// routes whose local x-eos-ui-token the gateway supplies to a joined device.

import type { RemoteTier } from "../../contracts/src/remote.ts";

interface TierRule {
  method: string;
  re: RegExp;
  tier: RemoteTier;
  uiToken?: boolean;
}

// :seg matches one non-slash path segment.
function pat(path: string): RegExp {
  const body = path.replace(/:[A-Za-z0-9_]+/g, "[^/]+");
  return new RegExp(`^${body}$`);
}
const R = (method: string, path: string, tier: RemoteTier, uiToken = false): TierRule => ({ method, re: pat(path), tier, uiToken });

const RULES: TierRule[] = [
  // ---- READ ----
  ...[
    "/workers", "/workers/:id", "/workers/:id/events", "/workers/:id/queue",
    "/workers/:id/diff", "/workers/:id/changes", "/workers/:id/changes/file",
    "/workers/:id/conflicts", "/workers/:id/conflicts/file", "/workers/:id/push-state",
    "/workers/:id/memory", "/workers/:id/peers", "/workers/:id/rewind-targets",
    "/workers/:id/try/preview", "/workers/:id/try/state", "/orchestrators", "/pending",
    "/health", "/fs/branches", "/fs/unpushed", "/fs/commit", "/fs/recents", "/fs/read",
    "/fs/list", "/fs/stat", "/fs/image", "/fs/icon", "/fs/default-app", "/api/ui-config",
    "/api/settings", "/commands", "/api/templates", "/api/prompts", "/worker-definitions",
    "/api/updates/status",
  ].map((p) => R("GET", p, "READ")),

  // Path-style binary asset reads (served out-of-band as `asset` frames). /fs/raw
  // carries a multi-segment file path after /fs/raw/; /pdfjs serves its vendored
  // viewer tree. Pure reads ⇒ READ. (/fs/image is query-style and already READ
  // above.) Bare /fs/raw is intentionally NOT matched — the real route requires a
  // sub-path, so it stays fail-closed REFUSED.
  { method: "GET", re: /^\/fs\/raw\/.+$/, tier: "READ" },
  { method: "GET", re: /^\/pdfjs(\/.*)?$/, tier: "READ" },

  // ---- LOW ----
  R("POST", "/workers/:id/message", "LOW"),
  R("POST", "/workers/:id/question-answer", "LOW"),
  R("POST", "/workers/:id/interrupt", "LOW"),
  R("POST", "/workers/:id/resume", "LOW"),
  R("POST", "/workers/:id/notify", "LOW"),
  R("POST", "/orchestrators/:id/message", "LOW"),
  R("POST", "/orchestrators/:id/loop", "LOW"),
  R("POST", "/orchestrators/:id/loop/stop", "LOW"),
  R("DELETE", "/workers/:id/queue/:queueId", "LOW"),
  R("PUT", "/workers/:id/name", "LOW"),
  R("PUT", "/workers/:id/rename-intent", "LOW"),
  R("PUT", "/workers/:id/model", "LOW"),
  R("POST", "/workers/:id/conflicts/resolve", "LOW"),

  // ---- HIGH (step-up). ✦ = ui-token-gated ----
  R("POST", "/workers", "HIGH"),
  R("POST", "/orchestrators", "HIGH"),
  R("DELETE", "/workers/:id", "HIGH"),
  R("POST", "/workers/:id/terminal", "HIGH", true),
  R("POST", "/terminal", "HIGH", true),
  R("POST", "/terminal/:runId/kill", "HIGH"),
  R("POST", "/workers/:id/action", "HIGH"),
  R("POST", "/workers/:id/push", "HIGH"),
  R("POST", "/workers/:id/pull", "HIGH"),
  R("POST", "/pending/:id/decision", "HIGH"),
  R("PUT", "/workers/:id/permission", "HIGH"),
  R("PUT", "/workers/:id/backend", "HIGH"),
  R("POST", "/workers/:id/open", "HIGH", true),
  R("POST", "/fs/open", "HIGH"),
  R("POST", "/fs/reveal", "HIGH"),
  R("POST", "/workers/:id/rewind", "HIGH"),
  R("POST", "/workers/:id/try", "HIGH"),
  R("POST", "/workers/:id/try/keep", "HIGH"),
  R("POST", "/workers/:id/try/discard", "HIGH"),
  R("POST", "/orchestrators/:id/integrate", "HIGH"),
  R("POST", "/workers/:id/changes/discard", "HIGH", true),
  R("DELETE", "/workers/:id/memory/:name", "HIGH", true),
  R("POST", "/fs/write", "HIGH", true),
  R("POST", "/fs/create", "HIGH", true),
  R("POST", "/fs/rename", "HIGH", true),
  R("POST", "/fs/move", "HIGH", true),
  R("POST", "/fs/trash", "HIGH", true),
  R("POST", "/fs/paste", "HIGH", true),
  R("POST", "/fs/watch", "HIGH", true),
  R("POST", "/fs/unwatch", "HIGH", true),
  R("POST", "/fs/checkout", "HIGH", true),
  R("POST", "/fs/branch/create", "HIGH", true),
  R("POST", "/fs/branch/rename", "HIGH", true),
  R("POST", "/fs/branch/delete", "HIGH", true),
  R("POST", "/fs/fetch", "HIGH", true),
  R("POST", "/fs/remote-branch/delete", "HIGH", true),
  R("POST", "/api/updates/apply", "HIGH", true),
  R("POST", "/api/policy/rule", "HIGH"),
  R("POST", "/api/templates", "HIGH"),
  R("PUT", "/api/templates/:name", "HIGH"),
  R("DELETE", "/api/templates/:name", "HIGH"),
  R("PUT", "/api/settings", "HIGH"),
  R("POST", "/api/updates/check", "HIGH"),
  R("POST", "/api/updates/defer", "HIGH"),

  // ---- REFUSED (never remote) ----
  ...[
    ["POST", "/workers/:id/events"], ["POST", "/policy/decide"], ["POST", "/workers/:id/question"],
    ["GET", "/workers/:id/question/:qId"], ["POST", "/workers/:id/peer-request"],
    ["GET", "/workers/:id/peer-request/:rId"], ["POST", "/workers/:id/peer-response"],
    ["POST", "/workers/:id/report"], ["POST", "/workers/:id/keystroke"],
    ["GET", "/pick-directory"], ["GET", "/pick-file"], ["GET", "/stream"], ["GET", "/metrics"],
  ].map(([m, p]) => R(m, p, "REFUSED")),
];

export interface TierMatch {
  tier: RemoteTier;
  uiToken: boolean;
}

// Classify a concrete control method+path. Matches on the PATH portion only —
// a query string (e.g. /fs/read?path=…) is stripped before matching so query
// reads don't fail closed (§4.2); the full path+query still dispatches. Fails
// closed to REFUSED for anything unrecognized.
export function classifyTier(method: string, path: string): TierMatch {
  const pathOnly = path.split("?", 1)[0];
  for (const rule of RULES) {
    if (rule.method === method && rule.re.test(pathOnly)) {
      return { tier: rule.tier, uiToken: rule.uiToken ?? false };
    }
  }
  return { tier: "REFUSED", uiToken: false };
}
