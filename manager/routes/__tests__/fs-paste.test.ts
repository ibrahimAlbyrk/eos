// POST /fs/paste — raw upload of a pasted/dropped file. The browser can only
// send ISO-8859-1 header values, so the UI percent-encodes x-filename; names
// with Turkish letters or macOS's U+202F must survive the round trip.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { Router } from "../Router.ts";
import { registerFsReadRoutes } from "../fs-read.ts";
import type { Container } from "../../container.ts";
import type { RouteContext } from "../Router.ts";

async function post(filename: string, body = "hello") {
  const router = new Router();
  registerFsReadRoutes(router, {} as unknown as Container);
  const u = new URL("http://x/fs/paste");
  const m = router.match("POST", u.pathname);
  assert.ok(m, "no POST route matched /fs/paste");
  const req = Object.assign(Readable.from([Buffer.from(body)]), {
    headers: { "content-type": "application/octet-stream", "x-filename": filename },
  }) as unknown as RouteContext["req"];
  let status = 0;
  let payload: { path?: string; error?: string } | undefined;
  const res = {
    req: { headers: {} },
    writeHead: (s: number) => { status = s; },
    end: (b?: string) => { payload = b ? JSON.parse(b) : undefined; },
  } as unknown as RouteContext["res"];
  await m.handler({ params: m.params, url: u, req, res } as RouteContext);
  return { status, payload };
}

describe("POST /fs/paste", () => {
  it("decodes a percent-encoded filename", async () => {
    const out = await post(encodeURIComponent("şema ğ PM.png"));
    assert.equal(out.status, 200);
    assert.equal(basename(out.payload?.path ?? ""), "şema ğ PM.png");
    assert.equal(readFileSync(out.payload?.path ?? "", "utf8"), "hello");
  });

  it("keeps a plain name that is not valid percent-encoding", async () => {
    const out = await post("100%.png");
    assert.equal(out.status, 200);
    assert.equal(basename(out.payload?.path ?? ""), "100%.png");
  });

  it("sanitizes a '/' that decoding reveals", async () => {
    const out = await post(encodeURIComponent("../a/b.png"));
    assert.equal(out.status, 200);
    assert.equal(basename(out.payload?.path ?? ""), ".._a_b.png");
  });
});
