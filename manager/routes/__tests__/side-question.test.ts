import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { Router, type RouteContext } from "../Router.ts";
import { registerSideQuestionRoutes } from "../side-question.ts";
import type { Container } from "../../container.ts";
import type { SideAnswer } from "../../../core/src/ports/AgentBackend.ts";
import { ConflictError, ValidationError } from "../../../core/src/errors/index.ts";

const UI = { "x-eos-ui-token": "tok" };

function makeContainer(askSide: (q: string, o?: { signal?: AbortSignal }) => Promise<SideAnswer>) {
  const asked: string[] = [];
  const session = {
    capabilities: { sideQuestion: true },
    isAlive: () => true,
    askSide: (q: string, o?: { signal?: AbortSignal }) => { asked.push(q); return askSide(q, o); },
  };
  const c = {
    uiToken: "tok",
    workers: { findById: (id: string) => (id === "w-1" ? { id, state: "IDLE", archived_at: null } : null) },
    inProcessSession: () => session,
  } as unknown as Container;
  return { c, asked };
}

function makeRes() {
  const res = Object.assign(new EventEmitter(), {
    req: { headers: {} },
    status: 0,
    payload: undefined as unknown,
    writableEnded: false,
    writeHead(s: number) { res.status = s; },
    end(b?: string) { res.payload = b ? JSON.parse(b) : undefined; res.writableEnded = true; },
  });
  return res;
}

function start(c: Container, body: unknown, headers: Record<string, string> = UI) {
  const router = new Router();
  registerSideQuestionRoutes(router, c);
  const u = new URL("http://x/workers/w-1/btw");
  const m = router.match("POST", u.pathname);
  assert.ok(m, "no POST route matched /workers/w-1/btw");
  const req = Object.assign(Readable.from([JSON.stringify(body)]), { headers }) as unknown as RouteContext["req"];
  const res = makeRes();
  const done = m.handler({ params: m.params, url: u, req, res: res as unknown as RouteContext["res"] } as RouteContext);
  return { res, done };
}

describe("side question route", () => {
  it("needs the ui token", async () => {
    const { c, asked } = makeContainer(async () => ({ ok: true, answer: "a" }));
    const { res, done } = start(c, { question: "why?" }, {});
    await done;
    assert.equal(res.status, 403);
    assert.equal(asked.length, 0);
  });

  it("answers with the session's reply", async () => {
    const { c, asked } = makeContainer(async () => ({ ok: true, answer: "because" }));
    const { res, done } = start(c, { question: " why? " });
    await done;
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, { answer: "because" });
    assert.deepEqual(asked, ["why?"]);
  });

  it("rejects an empty question", async () => {
    const { c } = makeContainer(async () => ({ ok: true, answer: "a" }));
    await assert.rejects(start(c, { question: "  " }).done, ValidationError);
  });

  it("turns a failed answer into a conflict", async () => {
    const { c } = makeContainer(async () => ({ ok: false, reason: "no answer" }));
    await assert.rejects(start(c, { question: "q" }).done, ConflictError);
  });

  it("cancels the answer when the caller goes away, and writes nothing", async () => {
    let signal: AbortSignal | undefined;
    const { c } = makeContainer((_q, o) => new Promise((resolve) => {
      signal = o?.signal;
      signal?.addEventListener("abort", () => resolve({ ok: false, reason: "Side question cancelled" }));
    }));
    const { res, done } = start(c, { question: "q" });
    await new Promise((r) => setImmediate(r));
    res.emit("close");
    await done;
    assert.equal(signal?.aborted, true);
    assert.equal(res.status, 0);
  });
});
