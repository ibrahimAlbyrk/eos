import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { unlinkSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { probeDaemon, waitHealthy, daemonPidAlive, unreachableHint } from "../../daemon-lifecycle.ts";

type FetchImpl = typeof fetch;
const realFetch = globalThis.fetch;
function setFetch(impl: FetchImpl) { (globalThis as { fetch: FetchImpl }).fetch = impl; }
afterEach(() => { (globalThis as { fetch: FetchImpl }).fetch = realFetch; });

/** The shape undici throws: the real errno sits on .cause. */
function fetchError(code: string): Error {
  const inner = new Error(`connect ${code}`) as Error & { code?: string };
  inner.code = code;
  const outer = new TypeError("fetch failed");
  (outer as { cause?: unknown }).cause = inner;
  return outer;
}

describe("probeDaemon — classifies why the daemon did not answer", () => {
  it("reports up on a 200", async () => {
    setFetch(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    assert.equal((await probeDaemon("http://x")).state, "up");
  });

  it("reports down on connection refused", async () => {
    setFetch(async () => { throw fetchError("ECONNREFUSED"); });
    assert.equal((await probeDaemon("http://x")).state, "down");
  });

  // The bug this exists for: no ephemeral port left means the probe cannot be
  // MADE, so daemon state is unknown — reading it as "down" started a second
  // daemon on top of a healthy one, which then died on EADDRINUSE.
  it("reports unreachable when the local port range is exhausted", async () => {
    setFetch(async () => { throw fetchError("EADDRNOTAVAIL"); });
    const r = await probeDaemon("http://x");
    assert.equal(r.state, "unreachable");
    assert.equal(r.state === "unreachable" && r.code, "EADDRNOTAVAIL");
  });

  it("reports unreachable when out of file descriptors", async () => {
    setFetch(async () => { throw fetchError("EMFILE"); });
    assert.equal((await probeDaemon("http://x")).state, "unreachable");
  });
});

describe("probeDaemon — unix socket first", () => {
  const sockPath = join(tmpdir(), `eos-probe-test-${process.pid}.sock`);
  let server: Server;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ sourceStamp: "abc" }));
    });
    await new Promise<void>((r) => server.listen(sockPath, r));
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    try { unlinkSync(sockPath); } catch {}
  });

  // The socket answers without an ephemeral port, so it still works on the very
  // machine where every TCP connect fails — that is the point of trying it first.
  it("answers over the socket even when TCP cannot connect at all", async () => {
    setFetch(async () => { throw fetchError("EADDRNOTAVAIL"); });
    const r = await probeDaemon("http://x", sockPath);
    assert.equal(r.state, "up");
    assert.deepEqual(r.state === "up" && r.body, { sourceStamp: "abc" });
  });

  it("falls through to TCP when the socket path does not exist", async () => {
    setFetch(async () => new Response("{}", { status: 200 }));
    const r = await probeDaemon("http://x", join(tmpdir(), "eos-probe-absent.sock"));
    assert.equal(r.state, "up");
  });
});

describe("waitHealthy", () => {
  it("gives up immediately on an unreachable probe instead of polling", async () => {
    let calls = 0;
    setFetch(async () => { calls++; throw fetchError("EADDRNOTAVAIL"); });
    const r = await waitHealthy("http://x", 20);
    assert.equal(r.state, "unreachable");
    assert.equal(calls, 1);
  });

  it("keeps polling a down daemon until it answers", async () => {
    let calls = 0;
    setFetch(async () => {
      calls++;
      if (calls < 3) throw fetchError("ECONNREFUSED");
      return new Response("{}", { status: 200 });
    });
    const r = await waitHealthy("http://x", 20);
    assert.equal(r.state, "up");
    assert.equal(calls, 3);
  });
});

describe("daemonPidAlive", () => {
  const dir = mkdtempSync(join(tmpdir(), "eos-pid-"));
  after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  it("returns null when the pid file is absent", () => {
    assert.equal(daemonPidAlive(join(dir, "absent.pid")), null);
  });

  it("returns null for a dead pid", () => {
    const f = join(dir, "dead.pid");
    // A pid that cannot exist: kill(0) on it throws ESRCH.
    writeFileSync(f, "999999");
    assert.equal(daemonPidAlive(f), null);
  });

  it("returns null on a corrupt pid file", () => {
    const f = join(dir, "junk.pid");
    writeFileSync(f, "not-a-pid");
    assert.equal(daemonPidAlive(f), null);
  });

  it("returns the pid of a live process", () => {
    const f = join(dir, "live.pid");
    writeFileSync(f, String(process.pid));
    assert.equal(daemonPidAlive(f), process.pid);
  });
});

describe("unreachableHint", () => {
  it("names the port range and the fix for EADDRNOTAVAIL", () => {
    const h = unreachableHint("EADDRNOTAVAIL");
    assert.match(h, /ephemeral port/);
    assert.match(h, /net\.inet\.tcp\.msl/);
  });

  it("mentions file descriptors for EMFILE", () => {
    assert.match(unreachableHint("EMFILE"), /file descriptors/);
  });
});
