// POST /fs/paste-b64 — JSON twin of /fs/paste for the remote-control tunnel.
// Exercises decode → temp file → {path}, filename sanitization, the decoded
// 20 MB cap (413), and schema validation.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { Router } from "../Router.ts";
import { registerFsReadRoutes } from "../fs-read.ts";
import type { Container } from "../../container.ts";
import type { RouteContext } from "../Router.ts";
import { ValidationError } from "../../../core/src/errors/index.ts";

async function post(body: unknown) {
  const router = new Router();
  registerFsReadRoutes(router, {} as unknown as Container);
  const u = new URL("http://x/fs/paste-b64");
  const m = router.match("POST", u.pathname);
  assert.ok(m, "no POST route matched /fs/paste-b64");
  const req = Readable.from([JSON.stringify(body)]) as unknown as RouteContext["req"];
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

describe("POST /fs/paste-b64", () => {
  it("decodes base64 into a temp file and returns its path", async () => {
    const out = await post({ name: "note.txt", dataB64: Buffer.from("hello b64").toString("base64") });
    assert.equal(out.status, 200);
    assert.ok(out.payload?.path);
    assert.equal(basename(out.payload.path), "note.txt");
    assert.equal(readFileSync(out.payload.path, "utf8"), "hello b64");
  });

  it("sanitizes '/' and NUL out of the filename", async () => {
    const out = await post({ name: "a/b\0c.png", dataB64: Buffer.from("x").toString("base64") });
    assert.equal(out.status, 200);
    assert.ok(out.payload?.path);
    assert.equal(basename(out.payload.path), "a_b_c.png");
  });

  it("rejects a decoded payload over the 20 MB cap with 413", async () => {
    const big = Buffer.alloc(20 * 1024 * 1024 + 1).toString("base64");
    const out = await post({ name: "big.bin", dataB64: big });
    assert.equal(out.status, 413);
    assert.match(out.payload?.error ?? "", /too large/);
  });

  it("rejects missing fields with a ValidationError", async () => {
    await assert.rejects(post({ name: "x.png" }), ValidationError);
    await assert.rejects(post({ dataB64: "aGk=" }), ValidationError);
  });
});
