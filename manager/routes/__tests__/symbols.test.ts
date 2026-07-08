import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "../Router.ts";
import { registerSymbolRoutes } from "../symbols.ts";
import type { Container } from "../../container.ts";
import type { RouteContext } from "../Router.ts";
import type { SymbolOccurrence } from "../../../core/src/ports/SymbolIndex.ts";

const DEF: SymbolOccurrence = { name: "foo", kind: "function", role: "definition", path: "/proj/a.ts", line: 1, column: 1 };
const REF: SymbolOccurrence = { name: "foo", kind: "call", role: "reference", path: "/proj/b.ts", line: 9, column: 3 };

function fakeContainer() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const symbolIndex = {
    ensureIndexed: async (...args: unknown[]) => { calls.push({ fn: "ensureIndexed", args }); },
    definitions: async (...args: unknown[]) => { calls.push({ fn: "definitions", args }); return [DEF]; },
    references: async (...args: unknown[]) => { calls.push({ fn: "references", args }); return [DEF, REF]; },
    searchSymbols: async (...args: unknown[]) => { calls.push({ fn: "searchSymbols", args }); return [DEF]; },
    definitionsInFile: async (...args: unknown[]) => { calls.push({ fn: "definitionsInFile", args }); return [DEF]; },
    invalidate: async () => {},
    release: () => {},
  };
  const c = { symbolIndex } as unknown as Container;
  return { c, calls };
}

async function get(c: Container, path: string) {
  const router = new Router();
  registerSymbolRoutes(router, c);
  const u = new URL("http://x" + path);
  const m = router.match("GET", u.pathname);
  assert.ok(m, `no GET route matched ${u.pathname}`);
  let status = 0;
  let payload: unknown;
  const res = {
    req: { headers: {} },
    writeHead: (s: number) => { status = s; },
    end: (b?: string) => { payload = b ? JSON.parse(b) : undefined; },
  } as unknown as RouteContext["res"];
  await m.handler({ params: m.params, url: u, res } as RouteContext);
  return { status, payload: payload as Record<string, unknown> };
}

describe("GET /symbols/lookup", () => {
  it("want=definitions → definitions(root,name), returns occurrences", async () => {
    const { c, calls } = fakeContainer();
    const out = await get(c, "/symbols/lookup?root=/proj&name=foo");
    assert.equal(out.status, 200);
    assert.deepEqual(out.payload, { occurrences: [DEF] });
    assert.deepEqual(calls[0], { fn: "ensureIndexed", args: ["/proj"] });
    assert.deepEqual(calls[1], { fn: "definitions", args: ["/proj", "foo", undefined] });
  });

  it("want=references → references(root,name)", async () => {
    const { c, calls } = fakeContainer();
    const out = await get(c, "/symbols/lookup?root=/proj&name=foo&want=references");
    assert.deepEqual(out.payload, { occurrences: [DEF, REF] });
    assert.deepEqual(calls[1], { fn: "references", args: ["/proj", "foo"] });
  });

  it("rejects a non-absolute root (400) and a missing name (400)", async () => {
    const { c } = fakeContainer();
    assert.equal((await get(c, "/symbols/lookup?root=rel&name=foo")).status, 400);
    assert.equal((await get(c, "/symbols/lookup?root=/proj")).status, 400);
  });

  it("passes an in-root fromPath but drops one that escapes root", async () => {
    const root = mkdtempSync(join(tmpdir(), "eos-symroute-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "x");
    try {
      const inRoot = join(root, "src", "a.ts");
      const { c, calls } = fakeContainer();
      await get(c, `/symbols/lookup?root=${encodeURIComponent(root)}&name=foo&fromPath=${encodeURIComponent(inRoot)}`);
      assert.deepEqual(calls[1], { fn: "definitions", args: [root, "foo", inRoot] });

      const { c: c2, calls: calls2 } = fakeContainer();
      await get(c2, `/symbols/lookup?root=${encodeURIComponent(root)}&name=foo&fromPath=${encodeURIComponent("/etc/passwd")}`);
      assert.deepEqual(calls2[1], { fn: "definitions", args: [root, "foo", undefined] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("GET /symbols/file", () => {
  it("resolves an in-root path → definitionsInFile(root, abs), returns occurrences", async () => {
    const root = mkdtempSync(join(tmpdir(), "eos-symfile-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "x");
    try {
      const inRoot = join(root, "src", "a.ts");
      // The handler passes the sandbox-resolved (realpath'd) abs path to the port.
      const resolvedAbs = join(realpathSync(root), "src", "a.ts");
      const { c, calls } = fakeContainer();
      const out = await get(c, `/symbols/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(inRoot)}`);
      assert.equal(out.status, 200);
      assert.deepEqual(out.payload, { occurrences: [DEF] });
      assert.deepEqual(calls[0], { fn: "definitionsInFile", args: [root, resolvedAbs] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a non-absolute root (400) and a path escaping root (400)", async () => {
    const root = mkdtempSync(join(tmpdir(), "eos-symfile-"));
    try {
      assert.equal((await get(fakeContainer().c, "/symbols/file?root=rel&path=/x")).status, 400);
      const escape = await get(fakeContainer().c, `/symbols/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent("/etc/passwd")}`);
      assert.equal(escape.status, 400);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a missing path (400)", async () => {
    const root = mkdtempSync(join(tmpdir(), "eos-symfile-"));
    try {
      assert.equal((await get(fakeContainer().c, `/symbols/file?root=${encodeURIComponent(root)}`)).status, 400);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("GET /symbols/search", () => {
  it("returns symbols for a query", async () => {
    const { c, calls } = fakeContainer();
    const out = await get(c, "/symbols/search?root=/proj&query=fo&limit=10");
    assert.equal(out.status, 200);
    assert.deepEqual(out.payload, { symbols: [DEF] });
    assert.deepEqual(calls[1], { fn: "searchSymbols", args: ["/proj", "fo", 10] });
  });

  it("empty query short-circuits to [] without indexing", async () => {
    const { c, calls } = fakeContainer();
    const out = await get(c, "/symbols/search?root=/proj&query=");
    assert.deepEqual(out.payload, { symbols: [] });
    assert.equal(calls.length, 0);
  });

  it("rejects a non-absolute root (400)", async () => {
    const { c } = fakeContainer();
    assert.equal((await get(c, "/symbols/search?root=rel&query=fo")).status, 400);
  });
});
