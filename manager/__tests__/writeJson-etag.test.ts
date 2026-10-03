import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import type { ServerResponse } from "node:http";

import { writeJson } from "../middleware/errorHandler.ts";

interface Out { status?: number; headers?: Record<string, string>; body?: Buffer }

function call(body: unknown, req: { method: string; headers: Record<string, string> }, status = 200): Promise<Out> {
  return new Promise((resolve) => {
    const out: Out = {};
    const res = {
      req,
      getHeader: () => undefined,
      writeHead: (s: number, h: Record<string, string>) => { out.status = s; out.headers = h; },
      end: (b?: string | Buffer) => { out.body = b == null ? undefined : Buffer.from(b); resolve(out); },
    } as unknown as ServerResponse;
    writeJson(res, status, body);
  });
}

const big = { rows: Array.from({ length: 80 }, (_, i) => ({ id: `w-${i}`, state: "IDLE" })) };

describe("writeJson — conditional GETs", () => {
  it("tags a GET answer and answers a matching If-None-Match with a bodiless 304", async () => {
    const first = await call(big, { method: "GET", headers: {} });
    const etag = first.headers?.etag;
    assert.match(etag ?? "", /^W\/"[A-Za-z0-9_-]+"$/);
    assert.equal(first.headers?.["cache-control"], "no-cache");

    const again = await call(big, { method: "GET", headers: { "if-none-match": etag! } });
    assert.equal(again.status, 304);
    assert.equal(again.body, undefined);

    const changed = await call({ ...big, more: 1 }, { method: "GET", headers: { "if-none-match": etag! } });
    assert.equal(changed.status, 200, "a changed body is sent in full");
  });

  it("leaves mutations, errors and tiny answers untagged", async () => {
    assert.equal((await call(big, { method: "POST", headers: {} })).headers?.etag, undefined);
    assert.equal((await call(big, { method: "GET", headers: {} }, 404)).headers?.etag, undefined);
    assert.equal((await call({ ok: true }, { method: "GET", headers: {} })).headers?.etag, undefined);
  });

  it("gzips answers from 1 KB when the client accepts it", async () => {
    const out = await call(big, { method: "GET", headers: { "accept-encoding": "gzip" } });
    assert.equal(out.headers?.["content-encoding"], "gzip");
    assert.deepEqual(JSON.parse(gunzipSync(out.body!).toString("utf8")), big);
  });
});
