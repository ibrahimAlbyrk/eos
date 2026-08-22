import type { Router, RouteContext } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { uiTokenOk } from "./fs-shared.ts";
import {
  BrowserActRequestSchema,
  BrowserDeviceRequestSchema,
  BrowserElementQuerySchema,
  BrowserFillFormRequestSchema,
  BrowserFindRequestSchema,
  BrowserGetRequestSchema,
  BrowserMuteRequestSchema,
  BrowserNavigateRequestSchema,
  BrowserNewTabRequestSchema,
  BrowserPressRequestSchema,
  BrowserScreenshotRequestSchema,
  BrowserScrollRequestSchema,
  BrowserShowRequestSchema,
  BrowserSnapshotRequestSchema,
  BrowserTypeRequestSchema,
  BrowserWaitRequestSchema,
  GLOBAL_SESSION,
} from "../../contracts/src/browser.ts";
import { BrowserDisabledError, BrowserNavBlockedError, type BrowserActor } from "../services/BrowserService.ts";
import { StaleRefError } from "../../core/src/ports/BrowserEngine.ts";
import { sessionRootOf } from "../../core/src/services/session-root.ts";
import type { WorkerRepo } from "../../core/src/ports/WorkerRepo.ts";

// Browser subsystem REST surface — loopback-only, dual-identity, session-
// scoped. Identity is derived from HEADERS ALONE — request bodies (and an
// agent's query params) are never consulted, so an agent can neither claim to
// be the human nor claim another session:
//   - x-eos-ui-token (per-boot, held only by the panel's WebView) ⇒ human; the
//     session is the ?session= query param (the panel declares the session its
//     pane shows), else GLOBAL_SESSION.
//   - otherwise agent; x-eos-agent-id (attached by every ToolContext's
//     ctx.api) is validated against the workers repo and walked to its
//     parent-chain root = the session. Unknown/absent id ⇒ 409 under
//     perSession (unattributed calls must not land in someone's session), or
//     GLOBAL_SESSION under perSession=false (wave-1 single shared browser).
// The actor decides the EXPERIENCE (agents: nav allowlist + header redaction;
// humans: unrestricted); the session decides WHICH Chrome. Per-tab routes
// fence on the tab's owning session — acting on another session's tab is 403.
// Frames never travel here: they ride the binary WS at /browser/stream
// (manager/browser-ws.ts).
//
// Error mapping: disabled subsystem → 409; unattributed agent → 409; a
// stale/unknown `@eN` ref → 409 with the re-snapshot hint (never a silent
// wrong click); a navigation refused by browser.allowedOrigins → 403; another
// session's tab → 403; unknown tab → 404.

export class UnattributedAgentError extends Error {
  constructor() {
    super("unattributed agent call — x-eos-agent-id missing or unknown");
  }
}

export interface BrowserCaller {
  actor: BrowserActor;
  session: string;
  // The validated agent id (the timeline/activity attribution); null for the
  // human and for unattributed perSession=false fallbacks.
  agentId: string | null;
}

// Pure derivation — exported for tests. Headers only, never a body field.
export function resolveBrowserCaller(deps: {
  workers: Pick<WorkerRepo, "findById">;
  uiTokenOk: boolean;
  agentIdHeader: string | undefined;
  sessionParam: string | null;
  perSession: boolean;
}): BrowserCaller {
  if (deps.uiTokenOk) {
    return { actor: "human", session: deps.sessionParam || GLOBAL_SESSION, agentId: null };
  }
  const id = deps.agentIdHeader?.trim();
  if (id && deps.workers.findById(id)) {
    return { actor: "agent", session: sessionRootOf(deps.workers, id), agentId: id };
  }
  if (deps.perSession) throw new UnattributedAgentError();
  return { actor: "agent", session: GLOBAL_SESSION, agentId: null };
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function registerBrowserRoutes(r: Router, c: Container): void {
  const resolveCaller = (ctx: RouteContext): BrowserCaller =>
    resolveBrowserCaller({
      workers: c.workers,
      uiTokenOk: uiTokenOk(ctx.req, c.uiToken),
      agentIdHeader: headerValue(ctx.req.headers["x-eos-agent-id"]),
      sessionParam: ctx.url.searchParams.get("session"),
      perSession: c.config.browser.perSession,
    });

  const gated = (handler: (_ctx: RouteContext, _caller: BrowserCaller) => Promise<void> | void) =>
    async (ctx: RouteContext): Promise<void> => {
      try {
        await handler(ctx, resolveCaller(ctx));
      } catch (e) {
        if (e instanceof UnattributedAgentError) { writeJson(ctx.res, 409, { error: e.message }); return; }
        if (e instanceof BrowserDisabledError) { writeJson(ctx.res, 409, { error: e.message }); return; }
        if (e instanceof StaleRefError) { writeJson(ctx.res, 409, { error: e.message }); return; }
        if (e instanceof BrowserNavBlockedError) { writeJson(ctx.res, 403, { error: e.message }); return; }
        if (e instanceof Error && e.message.startsWith("unknown tab")) { writeJson(ctx.res, 404, { error: e.message }); return; }
        throw e;
      }
    };

  // Agent-bound responses pass through the header-redaction chokepoint; the
  // human panel sees payloads verbatim.
  const send = (res: RouteContext["res"], caller: BrowserCaller, payload: unknown): void => {
    writeJson(res, 200, caller.actor === "agent" ? c.browser.redactForAgent(payload) : payload);
  };

  // The session fence for per-tab routes: a tab owned by another session is
  // refused. An unknown tabId falls through to the service's unknown-tab 404.
  const fenceTab = (res: RouteContext["res"], caller: BrowserCaller, tabId: string): boolean => {
    const owner = c.browser.sessionOfTab(tabId);
    if (owner != null && owner !== c.browser.resolveSessionKey(caller.session)) {
      writeJson(res, 403, { error: "tab belongs to another session" });
      return false;
    }
    return true;
  };

  // Agent WRITE activity (browser:activity kind:"use") + the durable
  // browser_action timeline event. Exactly two verbs emit — a tab opened and a
  // page loaded (the "a new page appeared and I missed it" pain); clicks,
  // typing and scrolling never do. Human-actor calls never emit (the human is
  // already looking).
  const emitUse = (caller: BrowserCaller, tabId: string, verb: "new_tab" | "navigate", url?: string): void => {
    if (caller.actor !== "agent" || !caller.agentId) return;
    c.browser.publishActivity({
      sessionId: caller.session,
      workerId: caller.agentId,
      kind: "use",
      tabId,
      ...(url ? { url } : {}),
    });
    c.events.append(caller.agentId, c.clock.now(), "browser_action", { tabId, verb, ...(url ? { url } : {}) });
  };

  r.get("/browser/status", gated(({ res }, caller) => {
    send(res, caller, c.browser.status(caller.session));
  }));

  r.post("/browser/launch", gated(async ({ res }, caller) => {
    await c.browser.ensureLaunched(caller.session);
    send(res, caller, c.browser.status(caller.session));
  }));

  r.get("/browser/tabs", gated(async ({ res }, caller) => {
    send(res, caller, {
      tabs: await c.browser.listTabs(caller.session),
      sessionId: c.browser.resolveSessionKey(caller.session),
    });
  }));

  // The omitted-tabId default: resolve the caller session's ACTIVE tab — the
  // page the human sees (or the agent last opened/presented) in THAT session.
  // 409 when there is none: acting on an unexpected tab is worse than a clear
  // failure, so there is no first-tab fallback here or in the browser_* tools
  // that call this.
  r.get("/browser/active-tab", gated(({ res }, caller) => {
    const tabId = c.browser.activeTabId(caller.session);
    if (!tabId) { writeJson(res, 409, { error: "no active tab" }); return; }
    send(res, caller, { tabId });
  }));

  r.post("/browser/tabs", gated(async ({ req, res }, caller) => {
    const body = validate(BrowserNewTabRequestSchema, await readBody(req));
    const tabId = await c.browser.openTab(body.url, caller.actor, caller.session);
    emitUse(caller, tabId, "new_tab", body.url);
    send(res, caller, { tabId });
  }));

  // Present (browser_show): surface the panel on the caller session's tab.
  // Resolve tab (arg or the session's active tab) → record it as the session's
  // "look here" pointer → publish browser:activity kind:"present" (3s
  // per-session rate limit — the nag guard) + the durable timeline event.
  // Human calls resolve but emit nothing (the human is already looking).
  r.post("/browser/show", gated(async ({ req, res }, caller) => {
    const body = validate(BrowserShowRequestSchema, await readBody(req));
    const tabId = body.tabId ?? c.browser.activeTabId(caller.session);
    if (!tabId) { writeJson(res, 409, { error: "no active tab" }); return; }
    if (!fenceTab(res, caller, tabId)) return;
    c.browser.setActiveTab(caller.session, tabId);
    if (caller.actor === "agent" && caller.agentId) {
      if (c.browser.presentAllowed(caller.session)) {
        const url = await c.browser.get(tabId, { what: "url" }).then((g) => g.value).catch(() => undefined);
        c.browser.publishActivity({
          sessionId: caller.session,
          workerId: caller.agentId,
          kind: "present",
          tabId,
          ...(url ? { url } : {}),
        });
        c.events.append(caller.agentId, c.clock.now(), "browser_action", { tabId, verb: "show", ...(url ? { url } : {}) });
      } else {
        c.log.info("browser present rate-limited", { sessionId: caller.session, workerId: caller.agentId, tabId });
      }
    }
    send(res, caller, { ok: true, tabId });
  }));

  r.del(/^\/browser\/tabs\/(?<tabId>[^/]+)$/, gated(async ({ params, res }, caller) => {
    if (!fenceTab(res, caller, params.tabId)) return;
    await c.browser.closeTab(params.tabId);
    send(res, caller, { ok: true });
  }));

  r.post(/^\/browser\/tabs\/(?<tabId>[^/]+)\/navigate$/, gated(async ({ params, req, res }, caller) => {
    if (!fenceTab(res, caller, params.tabId)) return;
    const body = validate(BrowserNavigateRequestSchema, await readBody(req));
    await c.browser.navigate(params.tabId, body, caller.actor);
    if (body.action === "url") emitUse(caller, params.tabId, "navigate", body.url);
    send(res, caller, { ok: true });
  }));

  r.post(/^\/browser\/tabs\/(?<tabId>[^/]+)\/snapshot$/, gated(async ({ params, req, res }, caller) => {
    if (!fenceTab(res, caller, params.tabId)) return;
    const body = validate(BrowserSnapshotRequestSchema, await readBody(req));
    send(res, caller, await c.browser.snapshot(params.tabId, body));
  }));

  r.post(/^\/browser\/tabs\/(?<tabId>[^/]+)\/find$/, gated(async ({ params, req, res }, caller) => {
    if (!fenceTab(res, caller, params.tabId)) return;
    const body = validate(BrowserFindRequestSchema, await readBody(req));
    send(res, caller, await c.browser.find(params.tabId, body.query));
  }));

  r.post(/^\/browser\/tabs\/(?<tabId>[^/]+)\/wait$/, gated(async ({ params, req, res }, caller) => {
    if (!fenceTab(res, caller, params.tabId)) return;
    const body = validate(BrowserWaitRequestSchema, await readBody(req));
    send(res, caller, await c.browser.wait(params.tabId, body));
  }));

  // act / type / fill_form / press / scroll all land here (plan §3.2 — the
  // verb is in the body). Dispatch is by shape: each body form is distinct.
  r.post(/^\/browser\/tabs\/(?<tabId>[^/]+)\/act$/, gated(async ({ params, req, res }, caller) => {
    if (!fenceTab(res, caller, params.tabId)) return;
    const raw = (await readBody(req)) as Record<string, unknown>;
    const tabId = params.tabId;
    if (typeof raw.verb === "string") {
      send(res, caller, await c.browser.act(tabId, validate(BrowserActRequestSchema, raw)));
      return;
    }
    if (Array.isArray(raw.fields)) {
      send(res, caller, await c.browser.fillForm(tabId, validate(BrowserFillFormRequestSchema, raw)));
      return;
    }
    if (typeof raw.key === "string") {
      send(res, caller, await c.browser.press(tabId, validate(BrowserPressRequestSchema, raw)));
      return;
    }
    if (typeof raw.direction === "string") {
      send(res, caller, await c.browser.scroll(tabId, validate(BrowserScrollRequestSchema, raw)));
      return;
    }
    if (typeof raw.text === "string" && typeof raw.ref === "string") {
      send(res, caller, await c.browser.typeText(tabId, validate(BrowserTypeRequestSchema, raw)));
      return;
    }
    writeJson(res, 400, { error: "unrecognized act body — expected one of: {ref,verb}, {ref,text}, {fields}, {key}, {direction}" });
  }));

  r.post(/^\/browser\/tabs\/(?<tabId>[^/]+)\/get$/, gated(async ({ params, req, res }, caller) => {
    if (!fenceTab(res, caller, params.tabId)) return;
    const body = validate(BrowserGetRequestSchema, await readBody(req));
    send(res, caller, await c.browser.get(params.tabId, body));
  }));

  r.post(/^\/browser\/tabs\/(?<tabId>[^/]+)\/capture$/, gated(async ({ params, req, res }, caller) => {
    if (!fenceTab(res, caller, params.tabId)) return;
    const body = validate(BrowserScreenshotRequestSchema, await readBody(req));
    send(res, caller, await c.browser.capture(params.tabId, body.fullPage));
  }));

  r.post(/^\/browser\/tabs\/(?<tabId>[^/]+)\/device$/, gated(async ({ params, req, res }, caller) => {
    if (!fenceTab(res, caller, params.tabId)) return;
    const body = validate(BrowserDeviceRequestSchema, await readBody(req));
    send(res, caller, await c.browser.setDevice(params.tabId, body.device));
  }));

  r.post(/^\/browser\/tabs\/(?<tabId>[^/]+)\/elements$/, gated(async ({ params, req, res }, caller) => {
    if (!fenceTab(res, caller, params.tabId)) return;
    const body = validate(BrowserElementQuerySchema, await readBody(req));
    send(res, caller, await c.browser.elementAt(params.tabId, body));
  }));

  r.post(/^\/browser\/tabs\/(?<tabId>[^/]+)\/mute$/, gated(async ({ params, req, res }, caller) => {
    if (!fenceTab(res, caller, params.tabId)) return;
    const body = validate(BrowserMuteRequestSchema, await readBody(req));
    send(res, caller, await c.browser.setMuted(params.tabId, body.muted));
  }));
}
