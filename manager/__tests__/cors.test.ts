import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { APP_ORIGIN, apiHosts, apiOrigins, applyCors, checkOrigin, hostAllowed } from "../middleware/cors.ts";

const PORT = 7400;

describe("checkOrigin", () => {
  const allowed = apiOrigins(PORT);

  it("allows the app and the daemon's own loopback origins", () => {
    for (const o of [APP_ORIGIN, "http://127.0.0.1:7400", "http://localhost:7400", "http://[::1]:7400"]) {
      assert.deepEqual(checkOrigin(o, allowed), { kind: "allowed", origin: o }, o);
    }
  });

  it("refuses null, the raw-content port, other ports and any web page", () => {
    for (const o of [
      "null", "http://127.0.0.1:7401", "http://127.0.0.1:5173", "http://localhost:7401", "https://evil.example",
      "eos://app.evil", "eos://other", "EOS://APP", "http://127.0.0.1:7400.evil.example", "", "http://127.0.0.1",
    ]) {
      assert.equal(checkOrigin(o, allowed).kind, "refused", o);
    }
    assert.equal(checkOrigin([APP_ORIGIN, APP_ORIGIN], allowed).kind, "refused", "a repeated header");
  });

  it("lets a request without an Origin through (CLI, MCP, hooks, the app's main process)", () => {
    assert.deepEqual(checkOrigin(undefined, allowed), { kind: "none" });
  });
});

describe("hostAllowed (DNS rebinding)", () => {
  const allowed = apiHosts("127.0.0.1");

  it("passes loopback names on any port, and a request with no Host", () => {
    for (const h of ["127.0.0.1:7400", "localhost:7400", "LOCALHOST", "[::1]:7400", "127.0.0.1", undefined, ""]) {
      assert.equal(hostAllowed(h, allowed), true, String(h));
    }
  });

  it("refuses any other name — a rebound page arrives under its own", () => {
    for (const h of ["evil.example:7400", "127.0.0.1.nip.io:7400", "127.0.0.1:7400@evil.example", "localhost:7400/x", "localhost.:7400", "0.0.0.0:7400", "[::]:7400"]) {
      assert.equal(hostAllowed(h, allowed), false, h);
    }
    assert.equal(hostAllowed(["127.0.0.1:7400", "127.0.0.1:7400"], allowed), false);
  });

  it("adds a specific bind address, never a wildcard", () => {
    assert.equal(hostAllowed("192.168.1.5:7400", apiHosts("192.168.1.5")), true);
    assert.equal(hostAllowed("0.0.0.0:7400", apiHosts("0.0.0.0")), false);
  });
});

describe("applyCors on a live server", () => {
  let server: Server;
  let port = 0;
  let reached = 0;

  before(async () => {
    server = createServer((req, res) => {
      if (!applyCors(req, res, apiOrigins(PORT))) return;
      reached++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  function send(method: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path: "/workers/x/message", headers }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      });
      req.on("error", reject);
      req.end(method === "POST" ? '{"text":"hi"}' : undefined);
    });
  }

  it("serves the app and reflects its origin", async () => {
    const before = reached;
    const r = await send("POST", { origin: APP_ORIGIN, "content-type": "application/json" });
    assert.equal(r.status, 200);
    assert.equal(r.headers["access-control-allow-origin"], APP_ORIGIN);
    assert.equal(reached, before + 1);
  });

  it("answers the app's preflight without running the route", async () => {
    const before = reached;
    const r = await send("OPTIONS", { origin: APP_ORIGIN, "access-control-request-method": "PUT" });
    assert.equal(r.status, 204);
    assert.equal(r.headers["access-control-allow-origin"], APP_ORIGIN);
    assert.match(String(r.headers["access-control-allow-headers"]), /x-eos-ui-token/);
    assert.equal(reached, before);
  });

  it("never runs a simple request from a sandboxed frame or a foreign page", async () => {
    const before = reached;
    for (const origin of ["null", "https://evil.example", "http://127.0.0.1:7401"]) {
      const r = await send("POST", { origin, "content-type": "text/plain" });
      assert.equal(r.status, 403, origin);
      assert.equal(r.headers["access-control-allow-origin"], undefined, origin);
      const pre = await send("OPTIONS", { origin, "access-control-request-method": "POST" });
      assert.equal(pre.status, 403, `${origin} preflight`);
    }
    assert.equal(reached, before);
  });

  it("serves clients that send no Origin, without CORS grants", async () => {
    const r = await send("GET", {});
    assert.equal(r.status, 200);
    assert.equal(r.headers["access-control-allow-origin"], undefined);
  });
});
