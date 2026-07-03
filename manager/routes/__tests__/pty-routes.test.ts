import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Router } from "../Router.ts";
import { registerPtyRoutes } from "../pty.ts";
import { handleError } from "../../middleware/errorHandler.ts";
import { PtyCapError } from "../../services/PtySessionService.ts";
import type { Container } from "../../container.ts";
import type { RouteContext } from "../Router.ts";
import type { PtySession } from "../../../contracts/src/http.ts";

const TOKEN = "ui-token-abc";

// Minimal ptySessions double — the routes only forward to it; the real service
// behavior is covered in services/__tests__/PtySessionService.test.ts.
function containerWith(over: Record<string, unknown> = {}, live = new Set<string>()) {
  const session: PtySession = { sessionId: "s1", number: 1, cwd: "/x", cols: 80, rows: 24, alive: true };
  const ptySessions = {
    create: (input: { cols: number; rows: number }): PtySession => ({ ...session, cols: input.cols, rows: input.rows }),
    list: (): PtySession[] => [...live].map((id) => ({ ...session, sessionId: id })),
    input: (id: string): boolean => live.has(id),
    resize: (id: string): boolean => live.has(id),
    buffer: (id: string): { seq: number; data: string } | null => (live.has(id) ? { seq: 3, data: "hi" } : null),
    kill: (id: string): boolean => live.has(id),
    ...over,
  };
  const c = { uiToken: TOKEN, ptySessions } as unknown as Container;
  return c;
}

async function dispatch(
  c: Container,
  method: "GET" | "POST" | "DELETE",
  path: string,
  opts: { body?: unknown; token?: string } = {},
): Promise<{ status: number; payload: unknown }> {
  const router = new Router();
  registerPtyRoutes(router, c);
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
    await m.handler({ params: m.params, req, res } as RouteContext);
  } catch (e) {
    // Mirror daemon.ts: domain errors (ValidationError -> 400) map centrally.
    handleError(res, e, { requestId: "t", method, path, log: noopLog });
  }
  return { status, payload };
}

describe("pty routes — ui-token gate", () => {
  it("rejects every route without the ui token (403)", async () => {
    const c = containerWith();
    const noTok = [
      ["POST", "/pty", { cols: 80, rows: 24 }],
      ["GET", "/pty", undefined],
      ["POST", "/pty/s1/input", { data: "x" }],
      ["POST", "/pty/s1/resize", { cols: 80, rows: 24 }],
      ["GET", "/pty/s1/buffer", undefined],
      ["DELETE", "/pty/s1", undefined],
    ] as const;
    for (const [method, path, body] of noTok) {
      const { status } = await dispatch(c, method, path, { body });
      assert.equal(status, 403, `${method} ${path} should be 403 without a token`);
    }
  });

  it("POST /pty with the token spawns a session", async () => {
    const c = containerWith();
    const { status, payload } = await dispatch(c, "POST", "/pty", { body: { cols: 120, rows: 40 }, token: TOKEN });
    assert.equal(status, 200);
    assert.equal((payload as PtySession).number, 1);
    assert.equal((payload as PtySession).cols, 120);
  });

  it("POST /pty maps the session cap to 429", async () => {
    const c = containerWith({ create: () => { throw new PtyCapError("full"); } });
    const { status } = await dispatch(c, "POST", "/pty", { body: { cols: 80, rows: 24 }, token: TOKEN });
    assert.equal(status, 429);
  });

  it("GET /pty lists sessions with the token", async () => {
    const c = containerWith({}, new Set(["s1"]));
    const { status, payload } = await dispatch(c, "GET", "/pty", { token: TOKEN });
    assert.equal(status, 200);
    assert.equal((payload as { sessions: PtySession[] }).sessions.length, 1);
  });

  it("input/resize/buffer/DELETE return 200 for a live session", async () => {
    const c = containerWith({}, new Set(["s1"]));
    assert.equal((await dispatch(c, "POST", "/pty/s1/input", { body: { data: "ls\r" }, token: TOKEN })).status, 200);
    assert.equal((await dispatch(c, "POST", "/pty/s1/resize", { body: { cols: 90, rows: 30 }, token: TOKEN })).status, 200);
    const buf = await dispatch(c, "GET", "/pty/s1/buffer", { token: TOKEN });
    assert.equal(buf.status, 200);
    assert.deepEqual(buf.payload, { seq: 3, data: "hi" });
    assert.equal((await dispatch(c, "DELETE", "/pty/s1", { token: TOKEN })).status, 200);
  });

  it("unknown session id → 404 (tokened)", async () => {
    const c = containerWith({}, new Set());
    assert.equal((await dispatch(c, "POST", "/pty/ghost/input", { body: { data: "x" }, token: TOKEN })).status, 404);
    assert.equal((await dispatch(c, "POST", "/pty/ghost/resize", { body: { cols: 80, rows: 24 }, token: TOKEN })).status, 404);
    assert.equal((await dispatch(c, "GET", "/pty/ghost/buffer", { token: TOKEN })).status, 404);
    assert.equal((await dispatch(c, "DELETE", "/pty/ghost", { token: TOKEN })).status, 404);
  });

  it("rejects a malformed create body (400)", async () => {
    const c = containerWith();
    const { status } = await dispatch(c, "POST", "/pty", { body: { cols: -1, rows: 24 }, token: TOKEN });
    assert.equal(status, 400);
  });
});
