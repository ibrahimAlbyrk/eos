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
  BrowserSnapshotRequestSchema,
  BrowserTypeRequestSchema,
  BrowserWaitRequestSchema,
} from "../../contracts/src/browser.ts";
import { BrowserDisabledError, BrowserNavBlockedError, type BrowserActor } from "../services/BrowserService.ts";
import { StaleRefError } from "../../core/src/ports/BrowserEngine.ts";

// Browser subsystem REST surface — loopback-only, dual-identity. The per-boot
// ui token (held only by the panel's WebView) marks a request "human"; a
// browser_* tool handler's ctx.api() is a bare loopback fetch with no token,
// so everything else is "agent". The actor is derived server-side from the
// header alone — request bodies are never consulted, so an agent cannot claim
// to be the human. The actor decides the EXPERIENCE (agents: nav allowlist +
// header redaction; humans: unrestricted), never WHETHER a route answers.
// Frames never travel here: they ride the binary WS at /browser/stream
// (manager/browser-ws.ts).
//
// Error mapping: disabled subsystem → 409; a stale/unknown `@eN` ref → 409
// with the re-snapshot hint (never a silent wrong click); a navigation refused
// by browser.allowedOrigins → 403; unknown tab → 404.

export function registerBrowserRoutes(r: Router, c: Container): void {
  const gated = (handler: (_ctx: RouteContext, _actor: BrowserActor) => Promise<void> | void) =>
    async (ctx: RouteContext): Promise<void> => {
      const actor: BrowserActor = uiTokenOk(ctx.req, c.uiToken) ? "human" : "agent";
      try {
        await handler(ctx, actor);
      } catch (e) {
        if (e instanceof BrowserDisabledError) { writeJson(ctx.res, 409, { error: e.message }); return; }
        if (e instanceof StaleRefError) { writeJson(ctx.res, 409, { error: e.message }); return; }
        if (e instanceof BrowserNavBlockedError) { writeJson(ctx.res, 403, { error: e.message }); return; }
        if (e instanceof Error && e.message.startsWith("unknown tab")) { writeJson(ctx.res, 404, { error: e.message }); return; }
        throw e;
      }
    };

  // Agent-bound responses pass through the header-redaction chokepoint; the
  // human panel sees payloads verbatim.
  const send = (res: RouteContext["res"], actor: BrowserActor, payload: unknown): void => {
    writeJson(res, 200, actor === "agent" ? c.browser.redactForAgent(payload) : payload);
  };

  r.get("/browser/status", gated(({ res }, actor) => {
    send(res, actor, c.browser.status());
  }));

  r.post("/browser/launch", gated(async ({ res }, actor) => {
    await c.browser.ensureLaunched();
    send(res, actor, c.browser.status());
  }));

  r.get("/browser/tabs", gated(async ({ res }, actor) => {
    send(res, actor, { tabs: await c.browser.listTabs() });
  }));

  // The omitted-tabId default: resolve the FOREGROUND (active) tab — the one
  // the panel is viewing — so an agent's tabId-less op targets the human's
  // page. 409 when there is none (only the keep-alive target, or nothing open):
  // acting on an unexpected tab is worse than a clear failure, so there is no
  // first-tab fallback here or in the browser_* tools that call this.
  r.get("/browser/active-tab", gated(({ res }, actor) => {
    const tabId = c.browser.activeTabId();
    if (!tabId) { writeJson(res, 409, { error: "no active tab" }); return; }
    send(res, actor, { tabId });
  }));

  r.post("/browser/tabs", gated(async ({ req, res }, actor) => {
    const body = validate(BrowserNewTabRequestSchema, await readBody(req));
    const tabId = await c.browser.openTab(body.url, actor);
    send(res, actor, { tabId });
  }));

  r.del(/^\/browser\/tabs\/(?<tabId>[^/]+)$/, gated(async ({ params, res }, actor) => {
    await c.browser.closeTab(params.tabId);
    send(res, actor, { ok: true });
  }));

  r.post(/^\/browser\/tabs\/(?<tabId>[^/]+)\/navigate$/, gated(async ({ params, req, res }, actor) => {
    const body = validate(BrowserNavigateRequestSchema, await readBody(req));
    await c.browser.navigate(params.tabId, body, actor);
    send(res, actor, { ok: true });
  }));

  r.post(/^\/browser\/tabs\/(?<tabId>[^/]+)\/snapshot$/, gated(async ({ params, req, res }, actor) => {
    const body = validate(BrowserSnapshotRequestSchema, await readBody(req));
    send(res, actor, await c.browser.snapshot(params.tabId, body));
  }));

  r.post(/^\/browser\/tabs\/(?<tabId>[^/]+)\/find$/, gated(async ({ params, req, res }, actor) => {
    const body = validate(BrowserFindRequestSchema, await readBody(req));
    send(res, actor, await c.browser.find(params.tabId, body.query));
  }));

  r.post(/^\/browser\/tabs\/(?<tabId>[^/]+)\/wait$/, gated(async ({ params, req, res }, actor) => {
    const body = validate(BrowserWaitRequestSchema, await readBody(req));
    send(res, actor, await c.browser.wait(params.tabId, body));
  }));

  // act / type / fill_form / press / scroll all land here (plan §3.2 — the
  // verb is in the body). Dispatch is by shape: each body form is distinct.
  r.post(/^\/browser\/tabs\/(?<tabId>[^/]+)\/act$/, gated(async ({ params, req, res }, actor) => {
    const raw = (await readBody(req)) as Record<string, unknown>;
    const tabId = params.tabId;
    if (typeof raw.verb === "string") {
      send(res, actor, await c.browser.act(tabId, validate(BrowserActRequestSchema, raw)));
      return;
    }
    if (Array.isArray(raw.fields)) {
      send(res, actor, await c.browser.fillForm(tabId, validate(BrowserFillFormRequestSchema, raw)));
      return;
    }
    if (typeof raw.key === "string") {
      send(res, actor, await c.browser.press(tabId, validate(BrowserPressRequestSchema, raw)));
      return;
    }
    if (typeof raw.direction === "string") {
      send(res, actor, await c.browser.scroll(tabId, validate(BrowserScrollRequestSchema, raw)));
      return;
    }
    if (typeof raw.text === "string" && typeof raw.ref === "string") {
      send(res, actor, await c.browser.typeText(tabId, validate(BrowserTypeRequestSchema, raw)));
      return;
    }
    writeJson(res, 400, { error: "unrecognized act body — expected one of: {ref,verb}, {ref,text}, {fields}, {key}, {direction}" });
  }));

  r.post(/^\/browser\/tabs\/(?<tabId>[^/]+)\/get$/, gated(async ({ params, req, res }, actor) => {
    const body = validate(BrowserGetRequestSchema, await readBody(req));
    send(res, actor, await c.browser.get(params.tabId, body));
  }));

  r.post(/^\/browser\/tabs\/(?<tabId>[^/]+)\/capture$/, gated(async ({ params, req, res }, actor) => {
    const body = validate(BrowserScreenshotRequestSchema, await readBody(req));
    send(res, actor, await c.browser.capture(params.tabId, body.fullPage));
  }));

  r.post(/^\/browser\/tabs\/(?<tabId>[^/]+)\/device$/, gated(async ({ params, req, res }, actor) => {
    const body = validate(BrowserDeviceRequestSchema, await readBody(req));
    send(res, actor, await c.browser.setDevice(params.tabId, body.device));
  }));

  r.post(/^\/browser\/tabs\/(?<tabId>[^/]+)\/elements$/, gated(async ({ params, req, res }, actor) => {
    const body = validate(BrowserElementQuerySchema, await readBody(req));
    send(res, actor, await c.browser.elementAt(params.tabId, body));
  }));

  r.post(/^\/browser\/tabs\/(?<tabId>[^/]+)\/mute$/, gated(async ({ params, req, res }, actor) => {
    const body = validate(BrowserMuteRequestSchema, await readBody(req));
    send(res, actor, await c.browser.setMuted(params.tabId, body.muted));
  }));
}
