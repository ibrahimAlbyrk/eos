import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Router } from "../Router.ts";
import type { RouteContext } from "../Router.ts";
import { registerBrowserRoutes, resolveBrowserCaller, UnattributedAgentError } from "../browser.ts";
import type { Container } from "../../container.ts";
import { BrowserService } from "../../services/BrowserService.ts";
import { GLOBAL_SESSION } from "../../../contracts/src/browser.ts";
import type { BrowserEngine, BrowserEngineTabInfo, BrowserFrame, DisplaySize } from "../../../core/src/ports/BrowserEngine.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";

// Wave-2 session scoping of the browser REST surface: actor + session are
// derived from HEADERS ONLY (ui token ⇒ human + ?session; x-eos-agent-id ⇒
// that agent's parent-chain root), body fields are never trusted, per-tab
// routes fence on the owning session, and the agent write verbs emit
// browser:activity + the durable browser_action timeline event.

const UI_TOKEN = "tok";

// The worker tree: two sessions, each a root with one child.
const TREE: Record<string, string | null> = {
  "o-root": null,
  "w-child": "o-root",
  "o-other": null,
  "w-other": "o-other",
};

class FakeEngine implements BrowserEngine {
  running = false;
  disposed = false;
  tabs: BrowserEngineTabInfo[] = [];
  private static nextId = 0;
  private exitCb: ((_info: { code: number | null }) => void) | null = null;
  active: string | null = null;

  async launch() { this.running = true; }
  isRunning() { return this.running; }
  binaryPath() { return "/fake/chrome"; }
  async openTab(url: string) {
    const tabId = `bt-${++FakeEngine.nextId}`;
    this.tabs.push({ tabId, url, title: "t", loading: false, canGoBack: false, canGoForward: false, audible: false, muted: false, faviconDataUri: null });
    this.active = tabId;
    return tabId;
  }
  async closeTab(tabId: string) { this.tabs = this.tabs.filter((t) => t.tabId !== tabId); }
  async listTabs() { return this.tabs; }
  activeTabId() { return this.active; }
  async navigate() {}
  async startScreencast(_t: string, _d: DisplaySize, _f: (_frame: BrowserFrame) => void) {}
  async stopScreencast() {}
  async setDisplaySize() {}
  async dispatchInput() {}
  viewport() { return { width: 1280, height: 800 }; }
  async snapshot() { return { url: "u", snapshot: "" }; }
  async find() { return []; }
  async act() {}
  async typeText() {}
  async press() {}
  async scroll() {}
  async get() { return "https://page.example/x"; }
  async capture() { return new Uint8Array([0xff, 0xd8]); }
  async setDevice() {}
  async elementAt() { return { ref: "@e1", tag: "a", role: "link", name: "x", box: [0, 0, 1, 1] as [number, number, number, number], focusable: true, locator: "role=link" }; }
  async textPresent() { return false; }
  async refVisible() { return false; }
  async setMuted() {}
  async setSilenced() {}
  onExit(cb: (_info: { code: number | null }) => void) { this.exitCb = cb; }
  onTabsChanged() {}
  dispose() { this.running = false; this.disposed = true; }
}

function makeHarness(opts: { perSession?: boolean; allowedOrigins?: string[] } = {}) {
  const config = {
    browser: {
      enabled: true,
      chromePath: null,
      allowedOrigins: opts.allowedOrigins ?? [],
      persistProfile: true,
      perSession: opts.perSession ?? true,
    },
  };
  const published: Array<{ topic: string; payload: unknown }> = [];
  const appended: Array<{ workerId: string; type: string; payload: unknown }> = [];
  const engines = new Map<string, FakeEngine>();
  const workers = {
    findById: (id: string): WorkerRow | null =>
      id in TREE ? ({ id, parent_id: TREE[id] } as WorkerRow) : null,
  };
  const browser = new BrowserService({
    engineFactory: (sessionKey) => {
      const e = new FakeEngine();
      engines.set(sessionKey, e);
      return e;
    },
    getConfig: () => config.browser,
    bus: { publish: (topic: string, payload: unknown) => published.push({ topic, payload }), subscribe: () => () => {} },
    log: { info: () => {}, warn: () => {} },
  });
  const c = {
    uiToken: UI_TOKEN,
    config,
    log: { info: () => {}, warn: () => {} },
    clock: { now: () => 42 },
    workers,
    events: {
      append: (workerId: string, _ts: number, type: string, payload: unknown) => {
        appended.push({ workerId, type, payload });
        return appended.length;
      },
    },
    browser,
  } as unknown as Container;
  const router = new Router();
  registerBrowserRoutes(router, c);

  async function dispatch(
    method: "GET" | "POST" | "DELETE",
    pathWithQuery: string,
    headers: Record<string, string> = {},
    body?: unknown,
  ) {
    const url = new URL(pathWithQuery, "http://localhost");
    const m = router.match(method, url.pathname);
    assert.ok(m, `no ${method} route matched ${url.pathname}`);
    const req = Readable.from([body === undefined ? "" : JSON.stringify(body)]) as unknown as RouteContext["req"];
    (req as unknown as { headers: Record<string, string> }).headers = headers;
    let status = 0;
    let payload: unknown;
    const res = {
      writeHead: (s: number) => { status = s; },
      end: (b?: string) => { payload = b ? JSON.parse(b) : undefined; },
    } as unknown as RouteContext["res"];
    await m.handler({ params: m.params, url, req, res, requestId: "t1", method, path: url.pathname } as RouteContext);
    return { status, payload: payload as Record<string, unknown> };
  }

  const asHuman = () => ({ "x-eos-ui-token": UI_TOKEN });
  const asAgent = (id: string) => ({ "x-eos-agent-id": id });
  const activities = () => published.filter((p) => p.topic === "browser:activity").map((p) => p.payload as Record<string, unknown>);
  return { dispatch, engines, published, appended, activities, asHuman, asAgent };
}

describe("resolveBrowserCaller — headers only", () => {
  const workers = {
    findById: (id: string): WorkerRow | null =>
      id in TREE ? ({ id, parent_id: TREE[id] } as WorkerRow) : null,
  };

  it("ui token ⇒ human with the declared ?session (default global)", () => {
    const h = resolveBrowserCaller({ workers, uiTokenOk: true, agentIdHeader: undefined, sessionParam: "o-root", perSession: true });
    assert.deepEqual(h, { actor: "human", session: "o-root", agentId: null });
    const g = resolveBrowserCaller({ workers, uiTokenOk: true, agentIdHeader: undefined, sessionParam: null, perSession: true });
    assert.equal(g.session, GLOBAL_SESSION);
  });

  it("a CHILD worker's agent id resolves to its root's session", () => {
    const a = resolveBrowserCaller({ workers, uiTokenOk: false, agentIdHeader: "w-child", sessionParam: null, perSession: true });
    assert.deepEqual(a, { actor: "agent", session: "o-root", agentId: "w-child" });
  });

  it("an agent's ?session is ignored — the header decides", () => {
    const a = resolveBrowserCaller({ workers, uiTokenOk: false, agentIdHeader: "w-other", sessionParam: "o-root", perSession: true });
    assert.equal(a.session, "o-other");
  });

  it("unknown/absent agent id: 409 under perSession, global fallback without it", () => {
    assert.throws(() => resolveBrowserCaller({ workers, uiTokenOk: false, agentIdHeader: undefined, sessionParam: null, perSession: true }), UnattributedAgentError);
    assert.throws(() => resolveBrowserCaller({ workers, uiTokenOk: false, agentIdHeader: "w-ghost", sessionParam: null, perSession: true }), UnattributedAgentError);
    const fallback = resolveBrowserCaller({ workers, uiTokenOk: false, agentIdHeader: "w-ghost", sessionParam: null, perSession: false });
    assert.deepEqual(fallback, { actor: "agent", session: GLOBAL_SESSION, agentId: null });
  });
});

describe("session scoping over the routes", () => {
  it("an agent call lands in its root's session; lists are disjoint per session", async () => {
    const { dispatch, engines, asHuman, asAgent } = makeHarness();
    const open = await dispatch("POST", "/browser/tabs", asAgent("w-child"), {});
    assert.equal(open.status, 200);
    const tabId = open.payload.tabId as string;
    assert.ok(engines.has("o-root"), "the child's call launched its ROOT session's engine");
    assert.ok(!engines.has("w-child"));

    const rootList = await dispatch("GET", "/browser/tabs?session=o-root", asHuman());
    assert.equal(rootList.status, 200);
    assert.deepEqual((rootList.payload.tabs as Array<{ tabId: string }>).map((t) => t.tabId), [tabId]);
    assert.equal(rootList.payload.sessionId, "o-root");

    const globalList = await dispatch("GET", "/browser/tabs", asHuman());
    assert.deepEqual(globalList.payload.tabs, [], "the global session does not see o-root's tabs");
    assert.equal(globalList.payload.sessionId, GLOBAL_SESSION);
  });

  it("a cross-session tabId is refused 403", async () => {
    const { dispatch, asAgent, asHuman } = makeHarness();
    const open = await dispatch("POST", "/browser/tabs", asAgent("w-child"), {});
    const tabId = open.payload.tabId as string;

    const foreign = await dispatch("POST", `/browser/tabs/${tabId}/navigate`, asAgent("w-other"), { action: "reload" });
    assert.equal(foreign.status, 403);
    assert.match(String((foreign.payload as { error: string }).error), /another session/);

    // The human is fenced to the session they declared; declaring the owning
    // session passes.
    const wrongHuman = await dispatch("POST", `/browser/tabs/${tabId}/navigate?session=o-other`, asHuman(), { action: "reload" });
    assert.equal(wrongHuman.status, 403);
    const rightHuman = await dispatch("POST", `/browser/tabs/${tabId}/navigate?session=o-root`, asHuman(), { action: "reload" });
    assert.equal(rightHuman.status, 200);

    // Same-session sibling agents share their session's tabs.
    const sibling = await dispatch("POST", `/browser/tabs/${tabId}/navigate`, asAgent("o-root"), { action: "reload" });
    assert.equal(sibling.status, 200);
  });

  it("body-supplied actor/session are ignored — identity comes from headers alone", async () => {
    const { dispatch, asHuman, asAgent } = makeHarness({ allowedOrigins: ["example.com"] });
    // The body claims to be the human in another session; the agent's nav
    // fence still applies and the tab still lands in the agent's root session.
    const blocked = await dispatch("POST", "/browser/tabs", asAgent("w-child"), {
      url: "https://evil.example",
      actor: "human",
      session: "o-other",
    });
    assert.equal(blocked.status, 403, "the allowlist fenced the forged 'human' body");

    const open = await dispatch("POST", "/browser/tabs", asAgent("w-child"), {
      url: "https://example.com/app",
      actor: "human",
      session: "o-other",
    });
    assert.equal(open.status, 200);
    const otherList = await dispatch("GET", "/browser/tabs?session=o-other", asHuman());
    assert.deepEqual(otherList.payload.tabs, [], "the body's session claim moved nothing");
    const rootList = await dispatch("GET", "/browser/tabs?session=o-root", asHuman());
    assert.equal((rootList.payload.tabs as unknown[]).length, 1);
  });

  it("an unattributed agent call is 409 under perSession and global under perSession:false", async () => {
    const strict = makeHarness();
    const denied = await strict.dispatch("POST", "/browser/tabs", {}, {});
    assert.equal(denied.status, 409);
    assert.match(String((denied.payload as { error: string }).error), /unattributed/);

    const compat = makeHarness({ perSession: false });
    const ok = await compat.dispatch("POST", "/browser/tabs", {}, {});
    assert.equal(ok.status, 200);
    assert.ok(compat.engines.has(GLOBAL_SESSION));
    assert.equal(compat.engines.size, 1);
  });

  it("GET /browser/status?session reports per-session engine state", async () => {
    const { dispatch, asHuman, asAgent } = makeHarness();
    const idle = await dispatch("GET", "/browser/status?session=o-root", asHuman());
    assert.equal(idle.payload.sessionId, "o-root");
    assert.equal(idle.payload.state, "launching", "lazy: nothing launched for the session yet");
    assert.equal(idle.payload.tabCount, 0);

    await dispatch("POST", "/browser/tabs", asAgent("w-child"), {});
    const running = await dispatch("GET", "/browser/status?session=o-root", asHuman());
    assert.equal(running.payload.state, "running");
    const other = await dispatch("GET", "/browser/status?session=o-other", asHuman());
    assert.equal(other.payload.state, "launching", "the other session's engine is still unlaunched");
  });
});

describe("browser:activity + browser_action timeline", () => {
  it("agent new_tab and navigate:url emit use + timeline; reload/act/human emit nothing", async () => {
    const { dispatch, activities, appended, asHuman, asAgent } = makeHarness();
    const open = await dispatch("POST", "/browser/tabs", asAgent("w-child"), {});
    const tabId = open.payload.tabId as string;
    assert.equal(activities().length, 1);
    assert.deepEqual(activities()[0], { sessionId: "o-root", workerId: "w-child", kind: "use", tabId });
    assert.deepEqual(appended, [{ workerId: "w-child", type: "browser_action", payload: { tabId, verb: "new_tab" } }]);

    await dispatch("POST", `/browser/tabs/${tabId}/navigate`, asAgent("w-child"), { action: "url", url: "https://a.example" });
    assert.equal(activities().length, 2);
    assert.deepEqual(activities()[1], { sessionId: "o-root", workerId: "w-child", kind: "use", tabId, url: "https://a.example" });
    assert.equal(appended.length, 2);
    assert.deepEqual(appended[1].payload, { tabId, verb: "navigate", url: "https://a.example" });

    // reload is not a page-appeared signal; clicks/typing never emit.
    await dispatch("POST", `/browser/tabs/${tabId}/navigate`, asAgent("w-child"), { action: "reload" });
    await dispatch("POST", `/browser/tabs/${tabId}/act`, asAgent("w-child"), { ref: "@e1", verb: "click" });
    assert.equal(activities().length, 2);
    assert.equal(appended.length, 2);

    // The human opening/navigating emits nothing — they are already looking.
    await dispatch("POST", "/browser/tabs?session=o-root", asHuman(), {});
    assert.equal(activities().length, 2);
    assert.equal(appended.length, 2);
  });

  it("POST /browser/show presents the session's tab with a 3s per-session rate limit", async () => {
    const { dispatch, activities, appended, asHuman, asAgent } = makeHarness();
    const none = await dispatch("POST", "/browser/show", asAgent("w-child"), {});
    assert.equal(none.status, 409, "no tab to present");

    const open = await dispatch("POST", "/browser/tabs", asAgent("w-child"), {});
    const tabId = open.payload.tabId as string;
    const shown = await dispatch("POST", "/browser/show", asAgent("w-child"), {});
    assert.equal(shown.status, 200);
    assert.deepEqual(shown.payload, { ok: true, tabId });
    const presents = activities().filter((a) => a.kind === "present");
    assert.equal(presents.length, 1);
    assert.deepEqual(presents[0], { sessionId: "o-root", workerId: "w-child", kind: "present", tabId, url: "https://page.example/x" });
    assert.deepEqual(appended.at(-1), { workerId: "w-child", type: "browser_action", payload: { tabId, verb: "show", url: "https://page.example/x" } });

    // A second present inside the window is dropped (still 200) — nag guard.
    const again = await dispatch("POST", "/browser/show", asAgent("w-child"), { tabId });
    assert.equal(again.status, 200);
    assert.equal(activities().filter((a) => a.kind === "present").length, 1);

    // Presenting another session's tab is fenced like every per-tab verb.
    const foreign = await dispatch("POST", "/browser/show", asAgent("w-other"), { tabId });
    assert.equal(foreign.status, 403);

    // A human show resolves but never emits activity.
    const human = await dispatch("POST", "/browser/show?session=o-root", asHuman(), {});
    assert.equal(human.status, 200);
    assert.equal(activities().filter((a) => a.kind === "present").length, 1);
  });
});
