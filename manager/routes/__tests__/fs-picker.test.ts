// POST /fs/open-in — path-based reveal/open. argv construction is unit-tested
// via the pure openInArgv helper (no spawn); the route tests only exercise the
// guard paths, which return before execFileSync.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Router } from "../Router.ts";
import { registerFsPickerRoutes, openInArgv } from "../fs-picker.ts";
import type { Container } from "../../container.ts";
import type { RouteContext } from "../Router.ts";
import { ValidationError } from "../../../core/src/errors/index.ts";
import { FsOpenInRequestSchema } from "../../../contracts/src/http.ts";

const UI_TOKEN = "tok";

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const router = new Router();
  registerFsPickerRoutes(router, { uiToken: UI_TOKEN } as unknown as Container);
  const u = new URL("http://x" + path);
  const m = router.match("POST", u.pathname);
  assert.ok(m, `no POST route matched ${u.pathname}`);
  const req = Object.assign(Readable.from([JSON.stringify(body)]), { headers }) as unknown as RouteContext["req"];
  let status = 0;
  let payload: unknown;
  const res = {
    req: { headers: {} },
    writeHead: (s: number) => { status = s; },
    end: (b?: string) => { payload = b ? JSON.parse(b) : undefined; },
  } as unknown as RouteContext["res"];
  await m.handler({ params: m.params, url: u, req, res } as RouteContext);
  return { status, payload };
}

describe("FsOpenInRequestSchema", () => {
  it("parses valid finder/vscode bodies", () => {
    assert.deepEqual(FsOpenInRequestSchema.parse({ path: "/a/b.ts", target: "finder" }), { path: "/a/b.ts", target: "finder" });
    assert.deepEqual(FsOpenInRequestSchema.parse({ path: "/a/b.ts", target: "vscode" }), { path: "/a/b.ts", target: "vscode" });
  });

  it("rejects unknown targets, empty path, missing fields", () => {
    assert.throws(() => FsOpenInRequestSchema.parse({ path: "/a", target: "sublime" }));
    assert.throws(() => FsOpenInRequestSchema.parse({ path: "", target: "finder" }));
    assert.throws(() => FsOpenInRequestSchema.parse({ target: "finder" }));
  });
});

describe("openInArgv", () => {
  it("finder → reveal (open -R path)", () => {
    assert.deepEqual(openInArgv("finder", "/repo/src/a.ts"), ["-R", "/repo/src/a.ts"]);
  });

  it("vscode → open -a Visual Studio Code path", () => {
    assert.deepEqual(openInArgv("vscode", "/repo/src/a.ts"), ["-a", "Visual Studio Code", "/repo/src/a.ts"]);
  });
});

describe("POST /fs/open-in guards", () => {
  it("non-absolute path → 400 (before any spawn)", async () => {
    const out = await post("/fs/open-in", { path: "relative/x.ts", target: "finder" });
    assert.equal(out.status, 400);
  });

  it("invalid target → ValidationError (mapped to 400 by the error handler)", async () => {
    await assert.rejects(post("/fs/open-in", { path: "/a/b.ts", target: "nope" }), ValidationError);
  });

  it("no ui token → 403 (before any spawn)", async () => {
    const out = await post("/fs/open-in", { path: "/a/b.ts", target: "finder" }, { "x-eos-ui-token": "wrong" });
    assert.equal(out.status, 403);
  });
});

describe("POST /fs/open and /fs/reveal guards", () => {
  for (const route of ["/fs/open", "/fs/reveal"]) {
    it(`${route} without the ui token → 403 (before any spawn)`, async () => {
      const out = await post(route, { path: "/Applications/Calculator.app" });
      assert.equal(out.status, 403);
    });
  }
});
