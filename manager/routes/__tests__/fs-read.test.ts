// GET /fs/read — text comes back with its line count; a NUL in the first 8 KB
// answers binary, over 8 MB answers large, both without the content.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "../Router.ts";
import { registerFsReadRoutes } from "../fs-read.ts";
import type { Container } from "../../container.ts";
import type { RouteContext } from "../Router.ts";

async function read(path: string) {
  const router = new Router();
  registerFsReadRoutes(router, {} as unknown as Container);
  const u = new URL(`http://x/fs/read?path=${encodeURIComponent(path)}`);
  const m = router.match("GET", u.pathname);
  assert.ok(m, "no GET route matched /fs/read");
  const req = { method: "GET", headers: {} } as unknown as RouteContext["req"];
  let status = 0;
  let body = "";
  const res = {
    req,
    writeHead: (s: number) => { status = s; },
    end: (b?: string) => { body = b ?? ""; },
  } as unknown as RouteContext["res"];
  await m.handler({ params: m.params, url: u, req, res } as RouteContext);
  return { status, body: JSON.parse(body) as Record<string, unknown> };
}

function readError(path: string): string {
  try { readFileSync(path); } catch (e) { return e instanceof Error ? e.message : String(e); }
  throw new Error(`${path} is readable`);
}

describe("GET /fs/read", () => {
  let dir: string;
  const file = (name: string, data: string | Buffer) => { const p = join(dir, name); writeFileSync(p, data); return p; };
  before(() => { dir = mkdtempSync(join(tmpdir(), "fs-read-")); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it("serves text with its line count and byte size", async () => {
    const p = file("a.txt", "a\nbç\n");
    assert.deepEqual(await read(p), { status: 200, body: { path: p, content: "a\nbç\n", lines: 3, size: 6 } });
    const empty = file("empty.txt", "");
    assert.deepEqual(await read(empty), { status: 200, body: { path: empty, content: "", lines: 1, size: 0 } });
  });

  it("answers binary for a NUL in the first 8 KB, text for one after it", async () => {
    const bin = file("a.bin", Buffer.concat([Buffer.from("PNG"), Buffer.alloc(1), Buffer.alloc(100, 1)]));
    assert.deepEqual(await read(bin), { status: 200, body: { path: bin, binary: true, size: 104 } });
    const late = "x".repeat(8192) + "\0";
    const p = file("late.txt", late);
    assert.deepEqual(await read(p), { status: 200, body: { path: p, content: late, lines: 1, size: 8193 } });
  });

  it("answers large over 8 MB, binary first when it has a NUL", async () => {
    const big = 8 * 1024 * 1024 + 1;
    const text = file("big.txt", Buffer.alloc(big, "a"));
    assert.deepEqual(await read(text), { status: 200, body: { path: text, large: true, size: big } });
    const bin = Buffer.alloc(big, "a");
    bin[10] = 0;
    const p = file("big.bin", bin);
    assert.deepEqual(await read(p), { status: 200, body: { path: p, binary: true, size: big } });
  });

  it("404s a missing file or a directory with the read error, 400s a relative path", async () => {
    const missing = join(dir, "missing.txt");
    assert.deepEqual(await read(missing), { status: 404, body: { error: readError(missing) } });
    assert.deepEqual(await read(dir), { status: 404, body: { error: readError(dir) } });
    assert.equal((await read("rel/a.txt")).status, 400);
  });
});
