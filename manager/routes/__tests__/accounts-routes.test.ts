import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Router } from "../Router.ts";
import { registerAccountRoutes } from "../accounts.ts";
import { handleError } from "../../middleware/errorHandler.ts";
import type { Container } from "../../container.ts";
import type { RouteContext } from "../Router.ts";
import type { SignInSession } from "../../../contracts/src/accounts.ts";

const TOKEN = "ui-token-abc";

function containerWith() {
  const calls: string[] = [];
  const session: SignInSession = { id: "s1", provider: "anthropic", state: "waiting", url: "https://claude.ai/oauth/authorize?x" };
  const c = {
    uiToken: TOKEN,
    accounts: { list: async () => [{ id: "anthropic" }] },
    signIns: {
      supports: (p: string) => p === "anthropic",
      start: (p: string) => { calls.push(`start:${p}`); return session; },
      signOut: async (p: string) => { calls.push(`signOut:${p}`); },
      get: (id: string) => (id === "s1" ? session : null),
      cancel: (id: string) => { calls.push(`cancel:${id}`); return id === "s1"; },
      submitCode: (id: string, code: string) => { calls.push(`code:${id}:${code}`); return id === "s1"; },
    },
  } as unknown as Container;
  return { c, calls };
}

async function dispatch(c: Container, method: "GET" | "POST" | "DELETE", path: string, opts: { body?: unknown; token?: string } = {}) {
  const router = new Router();
  registerAccountRoutes(router, c);
  const m = router.match(method, path);
  assert.ok(m, `no ${method} route matched ${path}`);
  const req = Readable.from([opts.body === undefined ? "" : JSON.stringify(opts.body)]) as unknown as RouteContext["req"];
  (req as unknown as { headers: Record<string, string> }).headers = opts.token ? { "x-eos-ui-token": opts.token } : {};
  let status = 0;
  let payload: unknown;
  const res = {
    req: { headers: {} },
    writeHead: (s: number): void => { status = s; },
    end: (b?: string): void => { payload = b ? JSON.parse(b) : undefined; },
  } as unknown as RouteContext["res"];
  const noopLog = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Parameters<typeof handleError>[2]["log"];
  try {
    await m.handler({ params: m.params, req, res, url: new URL(path, "http://daemon") } as RouteContext);
  } catch (e) {
    handleError(res, e, { requestId: "t", method, path, log: noopLog });
  }
  return { status, payload };
}

describe("accounts routes", () => {
  it("every route needs the ui token", async () => {
    const { c, calls } = containerWith();
    const routes = [
      ["GET", "/api/accounts"],
      ["POST", "/api/accounts/anthropic/sign-in"],
      ["DELETE", "/api/accounts/anthropic/sign-in"],
      ["GET", "/api/sign-ins/s1"],
      ["DELETE", "/api/sign-ins/s1"],
      ["POST", "/api/sign-ins/s1/code"],
    ] as const;
    for (const [method, path] of routes) {
      assert.equal((await dispatch(c, method, path, { body: { code: "x" } })).status, 403, `${method} ${path}`);
    }
    assert.deepEqual(calls, []);
  });

  it("lists accounts", async () => {
    const { c } = containerWith();
    const r = await dispatch(c, "GET", "/api/accounts", { token: TOKEN });
    assert.deepEqual(r, { status: 200, payload: { accounts: [{ id: "anthropic" }] } });
  });

  it("starts a sign-in (202) and 404s a provider without one", async () => {
    const { c, calls } = containerWith();
    assert.equal((await dispatch(c, "POST", "/api/accounts/anthropic/sign-in", { token: TOKEN })).status, 202);
    assert.equal((await dispatch(c, "POST", "/api/accounts/xai/sign-in", { token: TOKEN })).status, 404);
    assert.deepEqual(calls, ["start:anthropic"]);
  });

  it("signs out", async () => {
    const { c, calls } = containerWith();
    assert.equal((await dispatch(c, "DELETE", "/api/accounts/anthropic/sign-in", { token: TOKEN })).status, 200);
    assert.deepEqual(calls, ["signOut:anthropic"]);
  });

  it("polls, cancels and forwards a code", async () => {
    const { c, calls } = containerWith();
    assert.equal((await dispatch(c, "GET", "/api/sign-ins/s1", { token: TOKEN })).status, 200);
    assert.equal((await dispatch(c, "GET", "/api/sign-ins/zz", { token: TOKEN })).status, 404);
    assert.equal((await dispatch(c, "POST", "/api/sign-ins/s1/code", { token: TOKEN, body: { code: " abc " } })).status, 200);
    assert.equal((await dispatch(c, "POST", "/api/sign-ins/s1/code", { token: TOKEN, body: {} })).status, 400);
    assert.equal((await dispatch(c, "DELETE", "/api/sign-ins/s1", { token: TOKEN })).status, 200);
    assert.deepEqual(calls, ["code:s1:abc", "cancel:s1"]);
  });
});
