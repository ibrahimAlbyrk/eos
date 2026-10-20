// GET /fs/image — the file at a path can change, so the response must be
// revalidated (no-cache + ETag): unchanged → 304, edited → 200 with new bytes.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "../Router.ts";
import { registerFsReadRoutes } from "../fs-read.ts";
import type { Container } from "../../container.ts";
import type { RouteContext } from "../Router.ts";

async function get(path: string, ifNoneMatch?: string) {
  const router = new Router();
  registerFsReadRoutes(router, {} as unknown as Container);
  const u = new URL(`http://x/fs/image?path=${encodeURIComponent(path)}`);
  const m = router.match("GET", u.pathname);
  assert.ok(m, "no GET route matched /fs/image");
  const req = { headers: ifNoneMatch ? { "if-none-match": ifNoneMatch } : {} } as unknown as RouteContext["req"];
  let status = 0;
  let headers: Record<string, string> = {};
  let body: Buffer | undefined;
  const res = {
    req,
    writeHead: (s: number, h: Record<string, string>) => { status = s; headers = h; },
    end: (b?: Buffer) => { body = b; },
  } as unknown as RouteContext["res"];
  await m.handler({ params: m.params, url: u, req, res } as RouteContext);
  return { status, headers, body };
}

describe("GET /fs/image", () => {
  const file = join(mkdtempSync(join(tmpdir(), "fs-image-")), "a.png");

  it("serves no-cache with an ETag, 304 while unchanged, new bytes once edited", async () => {
    writeFileSync(file, "v1");
    const first = await get(file);
    assert.equal(first.status, 200);
    assert.equal(first.headers["cache-control"], "no-cache");
    assert.equal(first.body?.toString(), "v1");
    const etag = first.headers.etag;
    assert.ok(etag);

    assert.equal((await get(file, etag)).status, 304);

    writeFileSync(file, "v2!");
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const edited = await get(file, etag);
    assert.equal(edited.status, 200);
    assert.equal(edited.body?.toString(), "v2!");
    assert.notEqual(edited.headers.etag, etag);
  });

  it("404s a missing file", async () => {
    assert.equal((await get(file + ".missing")).status, 404);
  });
});
