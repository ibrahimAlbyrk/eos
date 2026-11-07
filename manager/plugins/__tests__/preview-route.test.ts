import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { Router, type RouteContext } from "../../routes/Router.ts";
import { registerPluginRoutes, type PluginRouteDeps } from "../routes.ts";
import type { PluginInfo } from "../../../contracts/src/plugin.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const info = (over: Partial<PluginInfo> = {}): PluginInfo => ({
  id: "wall", builtin: false, dir: "/h/plugins/wall", manifest: null, enabled: true, state: "active",
  error: null, rev: 2, hasUi: true, hasCss: true, settings: {}, ...over,
});

function deps(plugin: PluginInfo, app: { registered?: boolean; reply?: unknown } = {}) {
  const calls: unknown[][] = [];
  const d = {
    uiToken: "tok",
    dir: "/h/plugins",
    installer: {},
    plugins: {
      list: () => [plugin],
      get: () => plugin,
      isBusy: () => false,
      lastReport: () => ({ rev: plugin.rev, ok: true, at: 1 }),
    },
    app: {
      isRegistered: () => app.registered ?? true,
      rpc: async (...args: unknown[]) => {
        calls.push(args);
        return app.reply ?? { png: PNG.toString("base64"), surface: "main", view: "wall", width: 1000, height: 760, errors: [], available: { main: ["wall"], panel: [], header: [] } };
      },
    },
  } as unknown as PluginRouteDeps;
  return { d, calls };
}

async function preview(d: PluginRouteDeps, body: unknown) {
  const router = new Router();
  registerPluginRoutes(router, d);
  const u = new URL("http://x/api/plugins/wall/preview");
  const m = router.match("POST", u.pathname);
  assert.ok(m, "no preview route");
  const req = Object.assign(Readable.from([JSON.stringify(body)]), { headers: {} }) as unknown as RouteContext["req"];
  let status = 0;
  let payload: Record<string, unknown> = {};
  const res = {
    req: { headers: {} },
    setHeader: () => {},
    writeHead: (s: number) => { status = s; },
    end: (b?: string) => { payload = b ? JSON.parse(b) : {}; },
  } as unknown as RouteContext["res"];
  await m.handler({ params: m.params, url: u, req, res } as RouteContext);
  return { status, payload };
}

describe("POST /api/plugins/:id/preview", () => {
  it("asks the app to draw the current build and writes the picture to a file", async () => {
    const plugin = info();
    const { d, calls } = deps(plugin);
    const { status, payload } = await preview(d, { surface: "main", store: { notes: [{ text: "hi" }] } });
    assert.equal(status, 200);
    assert.deepEqual(calls, [["", "plugin.preview", [{ surface: "main", store: { notes: [{ text: "hi" }] }, plugin }]]]);
    assert.deepEqual(readFileSync(payload.path as string), PNG);
    assert.equal(payload.png, undefined);
    assert.equal(payload.build, 2);
    assert.deepEqual(payload.available, { main: ["wall"], panel: [], header: [] });
  });

  it("says why a plugin that can't load can't be drawn", async () => {
    const { d, calls } = deps(info({ state: "error", error: "ui.jsx:3:1: Unexpected" }));
    const { status, payload } = await preview(d, {});
    assert.equal(status, 409);
    assert.match(payload.error as string, /build failed: ui\.jsx:3:1/);
    assert.equal(calls.length, 0);
  });

  it("needs the app to be open", async () => {
    const { d } = deps(info(), { registered: false });
    const { status, payload } = await preview(d, {});
    assert.equal(status, 503);
    assert.match(payload.error as string, /app isn't open/);
  });

  it("refuses store keys a plugin couldn't use", async () => {
    const { d } = deps(info());
    await assert.rejects(preview(d, { store: { "bad key": 1 } }));
  });
});
