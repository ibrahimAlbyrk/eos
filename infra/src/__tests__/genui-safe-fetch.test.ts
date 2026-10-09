import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";

import { isBlockedAddress } from "../genui/net-guard.ts";
import { SafeFetchError, safeGet, type SafeGetOptions } from "../genui/safe-fetch.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

let server: Server;
let port = 0;
const hits: string[] = [];

// The test server lives on loopback, so the guard is told 127.0.0.1 is "public";
// every other private address stays refused.
const isBlocked = (a: string): boolean => a !== "127.0.0.1" && isBlockedAddress(a);
const DNS: Record<string, string> = { "public.test": "127.0.0.1", "rebind.test": "10.0.0.7", "lan.test": "192.168.1.20" };
const resolve: SafeGetOptions["resolve"] = async (host) => {
  const a = DNS[host];
  if (!a) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  return [{ address: a, family: 4 }];
};
const opts = (extra: Partial<SafeGetOptions> = {}): SafeGetOptions => ({ userAgent: "Eos/test", maxBytes: 4096, timeoutMs: 2000, resolve, isBlocked, ...extra });
const base = () => `http://public.test:${port}`;

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    assert.ok(e instanceof SafeFetchError, `expected SafeFetchError, got ${String(e)}`);
    return e.code;
  }
};

before(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? "");
    const url = req.url ?? "/";
    if (url === "/img.png") {
      assert.equal(req.headers["user-agent"], "Eos/test");
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG);
    } else if (url === "/big") {
      res.writeHead(200, { "content-type": "image/png", "content-length": 10_000 });
      res.end(Buffer.alloc(10_000));
    } else if (url === "/chunked-big") {
      res.writeHead(200, { "content-type": "image/png" });
      for (let i = 0; i < 10; i++) res.write(Buffer.alloc(1000));
      res.end();
    } else if (url === "/bomb") {
      res.writeHead(200, { "content-type": "image/png", "content-encoding": "gzip" });
      res.end(gzipSync(Buffer.alloc(1_000_000)));
    } else if (url === "/gz") {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
      res.end(gzipSync(Buffer.from("<html>hi</html>")));
    } else if (url === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html></html>");
    } else if (url === "/to-private") {
      res.writeHead(302, { location: "http://10.0.0.1/secret" });
      res.end();
    } else if (url === "/to-rebind") {
      res.writeHead(302, { location: `http://rebind.test:${port}/img.png` });
      res.end();
    } else if (url === "/to-metadata") {
      res.writeHead(307, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    } else if (url === "/to-img") {
      res.writeHead(301, { location: "/img.png" });
      res.end();
    } else if (url.startsWith("/loop")) {
      const n = Number(url.slice(5) || 0);
      res.writeHead(302, { location: `/loop${n + 1}` });
      res.end();
    } else if (url === "/slow") {
      // never answers
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

describe("safeGet", () => {
  it("fetches an image through the guarded lookup", async () => {
    const r = await safeGet(`${base()}/img.png`, opts({ acceptType: (t) => t.startsWith("image/") }));
    assert.equal(r.status, 200);
    assert.equal(r.contentType, "image/png");
    assert.deepEqual(r.body, PNG);
  });

  it("follows a same-site redirect and reports the final URL", async () => {
    const r = await safeGet(`${base()}/to-img`, opts());
    assert.equal(r.url, `${base()}/img.png`);
  });

  it("refuses private and loopback targets before connecting", async () => {
    const before = hits.length;
    assert.equal(await code(safeGet("http://lan.test/x", opts())), "blocked");
    assert.equal(await code(safeGet("http://10.0.0.1/x", opts())), "blocked");
    assert.equal(await code(safeGet("http://localhost:7400/health", { userAgent: "t", maxBytes: 10 })), "blocked");
    assert.equal(await code(safeGet("http://127.0.0.1:7400/health", { userAgent: "t", maxBytes: 10 })), "blocked");
    assert.equal(hits.length, before);
  });

  it("re-checks every redirect hop", async () => {
    assert.equal(await code(safeGet(`${base()}/to-private`, opts())), "blocked");
    assert.equal(await code(safeGet(`${base()}/to-rebind`, opts())), "blocked");
    assert.equal(await code(safeGet(`${base()}/to-metadata`, opts())), "blocked");
  });

  it("stops after three redirects", async () => {
    assert.equal(await code(safeGet(`${base()}/loop`, opts())), "redirects");
  });

  it("refuses an oversize body — declared, streamed or decompressed", async () => {
    assert.equal(await code(safeGet(`${base()}/big`, opts())), "too-large");
    assert.equal(await code(safeGet(`${base()}/chunked-big`, opts())), "too-large");
    assert.equal(await code(safeGet(`${base()}/bomb`, opts())), "too-large");
  });

  it("decodes gzip", async () => {
    const r = await safeGet(`${base()}/gz`, opts());
    assert.equal(r.body.toString(), "<html>hi</html>");
  });

  it("checks the content type before reading the body", async () => {
    assert.equal(await code(safeGet(`${base()}/page`, opts({ acceptType: (t) => t.startsWith("image/") }))), "type");
  });

  it("reports a non-2xx answer and a timeout", async () => {
    assert.equal(await code(safeGet(`${base()}/nope`, opts())), "status");
    assert.equal(await code(safeGet(`${base()}/slow`, opts({ timeoutMs: 150 }))), "timeout");
  });
});
