import { describe, it, afterEach, before, after } from "node:test";
import { createServer, type Server } from "node:http";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { daemonFetch, daemonApi } from "../http.ts";

// Mock global fetch — tests are pure (no network).
type FetchImpl = typeof fetch;
const realFetch = globalThis.fetch;

function setFetch(impl: FetchImpl) {
  (globalThis as { fetch: FetchImpl }).fetch = impl;
}

afterEach(() => { (globalThis as { fetch: FetchImpl }).fetch = realFetch; });

describe("daemonFetch — success paths", () => {
  it("returns ok=true on 200 with JSON body", async () => {
    setFetch(async () => new Response(JSON.stringify({ x: 1 }), { status: 200 }));
    const r = await daemonFetch("http://x", "GET", "/y");
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { x: 1 });
    assert.equal(r.networkError, null);
  });

  it("treats 201 Created as ok (POST /workers semantics)", async () => {
    setFetch(async () => new Response(JSON.stringify({ id: "w-1" }), { status: 201 }));
    const r = await daemonFetch("http://x", "POST", "/workers", { prompt: "go" });
    assert.equal(r.ok, true);
    assert.equal(r.status, 201);
  });

  it("returns empty object for empty body", async () => {
    setFetch(async () => new Response("", { status: 200 }));
    const r = await daemonFetch("http://x", "GET", "/y");
    assert.deepEqual(r.body, {});
  });

  it("keeps raw text when body is not JSON", async () => {
    setFetch(async () => new Response("plain text", { status: 200 }));
    const r = await daemonFetch("http://x", "GET", "/y");
    assert.equal(r.body, "plain text");
  });
});

describe("daemonFetch — error paths", () => {
  it("ok=false on 4xx", async () => {
    setFetch(async () => new Response(JSON.stringify({ error: "bad" }), { status: 400 }));
    const r = await daemonFetch("http://x", "GET", "/y");
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: "bad" });
  });

  it("ok=false on 5xx", async () => {
    setFetch(async () => new Response("oops", { status: 500 }));
    const r = await daemonFetch("http://x", "GET", "/y");
    assert.equal(r.ok, false);
    assert.equal(r.status, 500);
  });

  it("ok=false + networkError populated on connection failure", async () => {
    setFetch(async () => { throw new Error("ECONNREFUSED"); });
    const r = await daemonFetch("http://x", "GET", "/y");
    assert.equal(r.ok, false);
    assert.equal(r.status, 0);
    assert.ok(r.networkError);
    assert.match(r.networkError!.message, /ECONNREFUSED/);
  });
});

describe("daemonFetch — request shape", () => {
  it("sends content-type and JSON body when body provided", async () => {
    let seenInit: Parameters<typeof fetch>[1];
    setFetch(async (_input, init) => { seenInit = init; return new Response("{}", { status: 200 }); });
    await daemonFetch("http://x", "POST", "/y", { a: 1 });
    assert.equal(seenInit?.method, "POST");
    const headers = seenInit?.headers as Record<string, string>;
    assert.equal(headers["content-type"], "application/json");
    assert.equal(seenInit?.body, JSON.stringify({ a: 1 }));
  });

  it("omits body + content-type for GETs", async () => {
    let seenInit: Parameters<typeof fetch>[1];
    setFetch(async (_input, init) => { seenInit = init; return new Response("{}", { status: 200 }); });
    await daemonFetch("http://x", "GET", "/y");
    assert.equal(seenInit?.body, undefined);
    assert.equal(seenInit?.headers, undefined);
  });
});

describe("daemonApi — throwing variant", () => {
  it("resolves with body on success", async () => {
    setFetch(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    const out = await daemonApi("http://x", "GET", "/y");
    assert.deepEqual(out, { ok: 1 });
  });

  it("rejects with annotated message on network error", async () => {
    setFetch(async () => { throw new Error("dns"); });
    await assert.rejects(daemonApi("http://x", "GET", "/y"), /daemon unreachable.*dns/);
  });

  it("rejects on 4xx with status + body in message", async () => {
    setFetch(async () => new Response("nope", { status: 400 }));
    await assert.rejects(daemonApi("http://x", "GET", "/y"), /daemon 400: nope/);
  });
});

// EOS_DAEMON_SOCK path — a real unix-socket server, because the whole point of
// this branch is that it never touches the TCP stack (no ephemeral port, so no
// TIME_WAIT saturation). `fetch` is sabotaged to prove the socket is used.
describe("daemonFetch — unix socket transport", () => {
  const sockPath = join(tmpdir(), `eos-http-test-${process.pid}.sock`);
  let server: Server;
  let seen: { method: string; url: string; body: string } | null = null;

  before(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        seen = { method: req.method ?? "", url: req.url ?? "", body };
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "w-1" }));
      });
    });
    await new Promise<void>((r) => server.listen(sockPath, r));
    process.env.EOS_DAEMON_SOCK = sockPath;
    setFetch(() => { throw new Error("fetch must not be used when EOS_DAEMON_SOCK is set"); });
  });

  after(async () => {
    delete process.env.EOS_DAEMON_SOCK;
    await new Promise<void>((r) => server.close(() => r()));
    try { unlinkSync(sockPath); } catch {}
  });

  it("sends the request over the socket and parses the reply", async () => {
    const r = await daemonFetch("http://unused", "POST", "/workers", { prompt: "go" });
    assert.equal(r.ok, true);
    assert.equal(r.status, 201);
    assert.deepEqual(r.body, { id: "w-1" });
    assert.equal(seen?.method, "POST");
    assert.equal(seen?.url, "/workers");
    assert.deepEqual(JSON.parse(seen?.body ?? "{}"), { prompt: "go" });
  });

  it("falls back to TCP when the socket file is gone", async () => {
    process.env.EOS_DAEMON_SOCK = join(tmpdir(), "eos-http-test-absent.sock");
    setFetch(async () => new Response(JSON.stringify({ via: "tcp" }), { status: 200 }));
    const r = await daemonFetch("http://x", "GET", "/health");
    assert.equal(r.ok, true);
    assert.deepEqual(r.body, { via: "tcp" });
    process.env.EOS_DAEMON_SOCK = sockPath;
  });
});
