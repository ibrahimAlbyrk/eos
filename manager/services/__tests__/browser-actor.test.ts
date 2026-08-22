// Dual-identity browser routes: the actor is derived server-side from headers
// alone (ui token ⇒ human, x-eos-agent-id ⇒ that agent; a bare loopback call
// is unattributed — 409 under perSession, the global agent under
// perSession=false). These tests pin the security-relevant behaviour end to
// end through registerBrowserRoutes: derivation, forge-resistance (a body
// claiming actor:"human" changes nothing), the nav-policy asymmetry, and
// header redaction on the agent path.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Router } from "../../routes/Router.ts";
import type { RouteContext } from "../../routes/Router.ts";
import { registerBrowserRoutes } from "../../routes/browser.ts";
import { handleError } from "../../middleware/errorHandler.ts";
import { BrowserService, type BrowserActor } from "../BrowserService.ts";
import type { BrowserEngine } from "../../../core/src/ports/BrowserEngine.ts";
import type { Container } from "../../container.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";

const TOKEN = "ui-token-abc";
const AGENT = "w-agent";

async function dispatch(
  c: Container,
  method: "GET" | "POST" | "DELETE",
  path: string,
  opts: { body?: unknown; token?: string; agentId?: string } = {},
): Promise<{ status: number; payload: unknown }> {
  const router = new Router();
  registerBrowserRoutes(router, c);
  const url = new URL(path, "http://localhost");
  const m = router.match(method, url.pathname);
  assert.ok(m, `no ${method} route matched ${path}`);
  const req = Readable.from([opts.body === undefined ? "" : JSON.stringify(opts.body)]) as unknown as RouteContext["req"];
  (req as unknown as { headers: Record<string, string> }).headers = {
    ...(opts.token ? { "x-eos-ui-token": opts.token } : {}),
    ...(opts.agentId ? { "x-eos-agent-id": opts.agentId } : {}),
  };
  let status = 0;
  let payload: unknown;
  const res = {
    req: { headers: {} },
    writeHead: (s: number): void => { status = s; },
    end: (b?: string): void => { payload = b ? JSON.parse(b) : undefined; },
  } as unknown as RouteContext["res"];
  const noopLog = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Parameters<typeof handleError>[2]["log"];
  try {
    await m.handler({ params: m.params, url, req, res } as RouteContext);
  } catch (e) {
    handleError(res, e, { requestId: "t", method, path, log: noopLog });
  }
  return { status, payload };
}

// Container scaffolding shared by every case: the AGENT worker is a root row,
// so its session is itself.
function containerWith(browser: unknown, opts: { perSession?: boolean } = {}): Container {
  return {
    uiToken: TOKEN,
    config: { browser: { enabled: true, chromePath: null, allowedOrigins: [], persistProfile: true, perSession: opts.perSession ?? true } },
    log: { info() {}, warn() {} },
    clock: { now: () => 1 },
    workers: { findById: (id: string) => (id === AGENT ? ({ id, parent_id: null } as WorkerRow) : null) },
    events: { append: () => 1 },
    browser,
  } as unknown as Container;
}

// Real BrowserService over a minimal engine — the nav policy and redaction
// under test live in the service, not the engine.
function realService(allowedOrigins: string[] = [], perSession = true): BrowserService {
  const makeEngine = () => ({
    running: false,
    onExit() {},
    onTabsChanged() {},
    isRunning(): boolean { return this.running; },
    binaryPath() { return "/fake/chrome"; },
    async launch() { this.running = true; },
    async openTab() { return "bt-1"; },
    async navigate() {},
    async listTabs() { return []; },
    activeTabId() { return null; },
    viewport() { return { width: 1280, height: 800 }; },
    dispose() {},
  });
  return new BrowserService({
    engineFactory: () => makeEngine() as unknown as BrowserEngine,
    getConfig: () => ({ enabled: true, chromePath: null, allowedOrigins, persistProfile: true, perSession }),
    bus: { publish: () => {}, subscribe: () => () => {} } as never,
    log: { info() {}, warn() {} },
  });
}

describe("browser routes — actor derivation", () => {
  it("ui token ⇒ human; an agent header ⇒ agent; a body actor:\"human\" is ignored", async () => {
    const seen: BrowserActor[] = [];
    const browser = {
      navigate: async (_t: string, _r: unknown, actor: BrowserActor) => { seen.push(actor); },
      redactForAgent: <T,>(p: T): T => p,
      sessionOfTab: () => null,
      resolveSessionKey: (k: string) => k,
      publishActivity: () => {},
    };
    const c = containerWith(browser);
    await dispatch(c, "POST", "/browser/tabs/bt-1/navigate", { body: { action: "reload" }, token: TOKEN });
    await dispatch(c, "POST", "/browser/tabs/bt-1/navigate", { body: { action: "reload" }, agentId: AGENT });
    // A forged ui token does not make a human; the agent header still counts.
    await dispatch(c, "POST", "/browser/tabs/bt-1/navigate", { body: { action: "reload" }, token: "forged", agentId: AGENT });
    await dispatch(c, "POST", "/browser/tabs/bt-1/navigate", { body: { action: "reload", actor: "human" }, agentId: AGENT });
    assert.deepEqual(seen, ["human", "agent", "agent", "agent"]);
  });

  it("an unattributed loopback call is 409 under perSession and an agent under perSession:false", async () => {
    const strict = containerWith(realService());
    const denied = await dispatch(strict, "GET", "/browser/status", {});
    assert.equal(denied.status, 409);
    assert.match((denied.payload as { error: string }).error, /unattributed/);

    const compat = containerWith(realService([], false), { perSession: false });
    const res = await dispatch(compat, "GET", "/browser/status", {});
    assert.equal(res.status, 200);
    assert.ok((res.payload as { state: string }).state);
  });
});

describe("browser routes — nav-policy asymmetry", () => {
  it("agent navigation outside allowedOrigins is 403; the identical human navigation succeeds", async () => {
    const c = containerWith(realService(["example.com"]));
    const body = { action: "url", url: "https://evil.example" };
    const agent = await dispatch(c, "POST", "/browser/tabs/bt-1/navigate", { body, agentId: AGENT });
    assert.equal(agent.status, 403);
    assert.match((agent.payload as { error: string }).error, /not in browser\.allowedOrigins/);
    // The human navigates a real tab of their (global) session freely.
    const opened = await dispatch(c, "POST", "/browser/tabs", { body: {}, token: TOKEN });
    const tabId = (opened.payload as { tabId: string }).tabId;
    const human = await dispatch(c, "POST", `/browser/tabs/${tabId}/navigate`, { body, token: TOKEN });
    assert.equal(human.status, 200);
  });

  it("the same asymmetry gates opening a tab at a URL", async () => {
    const c = containerWith(realService(["example.com"]));
    const agent = await dispatch(c, "POST", "/browser/tabs", { body: { url: "https://evil.example" }, agentId: AGENT });
    assert.equal(agent.status, 403);
    const human = await dispatch(c, "POST", "/browser/tabs", { body: { url: "https://evil.example" }, token: TOKEN });
    assert.equal(human.status, 200);
    assert.equal((human.payload as { tabId: string }).tabId, "bt-1");
  });
});

describe("browser routes — active-tab resolution (the omitted-tabId default)", () => {
  it("409s 'no active tab' when nothing is foreground — no silent first-tab pick", async () => {
    const c = containerWith(realService());
    const res = await dispatch(c, "GET", "/browser/active-tab", { token: TOKEN });
    assert.equal(res.status, 409);
    assert.match((res.payload as { error: string }).error, /no active tab/);
  });

  it("returns { tabId } for the session's active tab", async () => {
    const service = realService();
    (service as unknown as { activeTabId: () => string | null }).activeTabId = () => "bt-7";
    const c = containerWith(service);
    const res = await dispatch(c, "GET", "/browser/active-tab", { token: TOKEN });
    assert.equal(res.status, 200);
    assert.equal((res.payload as { tabId: string }).tabId, "bt-7");
  });
});

describe("browser routes — header redaction on the agent path", () => {
  it("an agent response has credential headers stripped; the human response is verbatim", async () => {
    const service = realService();
    // No current response shape carries headers; simulate a future one to pin
    // the egress seam.
    (service as unknown as { snapshot: unknown }).snapshot = async () => ({
      tabId: "bt-1",
      url: "https://x.example",
      snapshot: "- page",
      responseHeaders: { Authorization: "Bearer abc", "Content-Type": "text/html" },
    });
    const c = containerWith(service);

    const agent = await dispatch(c, "POST", "/browser/tabs/bt-1/snapshot", { body: {}, agentId: AGENT });
    assert.equal(agent.status, 200);
    const agentHeaders = (agent.payload as { responseHeaders: Record<string, string> }).responseHeaders;
    assert.equal(agentHeaders.Authorization, "[redacted]");
    assert.equal(agentHeaders["Content-Type"], "text/html");

    const human = await dispatch(c, "POST", "/browser/tabs/bt-1/snapshot", { body: {}, token: TOKEN });
    const humanHeaders = (human.payload as { responseHeaders: Record<string, string> }).responseHeaders;
    assert.equal(humanHeaders.Authorization, "Bearer abc");
  });
});
