import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { Router, type RouteContext } from "../Router.ts";
import { registerSettingsRoutes } from "../settings.ts";
import type { Container } from "../../container.ts";
import { handleError } from "../../middleware/errorHandler.ts";
import { genuiSettingsOf } from "../../shared/genui-settings.ts";
import { ROUTES, type UserSettings } from "../../../contracts/src/http.ts";

const UI = { "x-eos-ui-token": "tok" };
const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLog };
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function makeContainer(initial: UserSettings = {}, configFile: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), "eos-genui-settings-"));
  dirs.push(home);
  writeFileSync(join(home, "config.json"), JSON.stringify({ compaction: { threshold: 0.8 }, ...configFile }));
  const store: UserSettings = { ...initial };
  let config = { daemon: { home }, genui: (configFile.genui ?? {}) as { logoDevKey?: string } };
  const c = {
    uiToken: "tok",
    get config() { return config; },
    reloadConfig() {
      const raw = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { genui?: { logoDevKey?: string } };
      config = { ...config, genui: raw.genui ?? {} };
    },
    userSettings: { read: () => ({ ...store }), patch: (p: UserSettings) => Object.assign(store, p) },
    genuiSettings: () => genuiSettingsOf(store, config),
  } as unknown as Container;
  return { c, store, configFile: () => JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as Record<string, any> };
}

async function call(c: Container, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const router = new Router();
  registerSettingsRoutes(router, c);
  const u = new URL("http://x" + path);
  const m = router.match(method, u.pathname);
  assert.ok(m, `no ${method} route matched ${u.pathname}`);
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body ?? {}))]), { headers }) as unknown as RouteContext["req"];
  let status = 0;
  let payload: unknown;
  const res = {
    req: { headers: {} },
    writeHead: (s: number) => { status = s; },
    end: (b?: string) => { payload = b ? JSON.parse(b) : undefined; },
  } as unknown as RouteContext["res"];
  try {
    await m.handler({ params: m.params, url: u, req, res } as RouteContext);
  } catch (e) {
    handleError(res, e, { requestId: "r", method, path, log: noopLog });
  }
  return { status, payload: payload as Record<string, any> };
}

describe("GET /api/settings/genui", () => {
  it("reads the defaults: balanced, apps on, location off, no logo key", async () => {
    const { c } = makeContainer();
    const r = await call(c, "GET", ROUTES.settingsGenui);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { level: "balanced", apps: true, locationShare: false, logoDevKey: null });
  });

  it("reads malformed values as their defaults", async () => {
    const { c } = makeContainer(
      { "genui.level": "loud", "genui.apps": "yes", "location.share": "true" },
      { genui: { logoDevKey: "sk_secret" } },
    );
    assert.deepEqual((await call(c, "GET", ROUTES.settingsGenui)).payload, { level: "balanced", apps: true, locationShare: false, logoDevKey: null });
  });
});

describe("PUT /api/settings/genui", () => {
  it("is the user's alone", async () => {
    const { c, store } = makeContainer();
    const callers: Record<string, string>[] = [{}, { "x-eos-agent-id": "orch" }, { "x-eos-ui-token": "nope" }];
    for (const headers of callers) {
      const r = await call(c, "PUT", ROUTES.settingsGenui, { locationShare: true }, headers);
      assert.equal(r.status, 403);
    }
    assert.deepEqual(store, {});
  });

  it("writes any subset: switches to settings.json, the logo key to config.json", async () => {
    const { c, store, configFile } = makeContainer();
    const r = await call(c, "PUT", ROUTES.settingsGenui, { level: "rich", locationShare: true, logoDevKey: "pk_abc123XYZ" }, UI);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { level: "rich", apps: true, locationShare: true, logoDevKey: "pk_abc123XYZ" });
    assert.deepEqual(store, { "genui.level": "rich", "location.share": true });
    assert.deepEqual(configFile().genui, { logoDevKey: "pk_abc123XYZ" });
    assert.deepEqual(configFile().compaction, { threshold: 0.8 }, "other blocks untouched");

    const apps = await call(c, "PUT", ROUTES.settingsGenui, { apps: false }, UI);
    assert.deepEqual(apps.payload, { level: "rich", apps: false, locationShare: true, logoDevKey: "pk_abc123XYZ" });
  });

  it("clears the logo key with null or an empty string", async () => {
    for (const clear of [null, ""]) {
      const { c, configFile } = makeContainer({}, { genui: { logoDevKey: "pk_abc123XYZ" } });
      const r = await call(c, "PUT", ROUTES.settingsGenui, { logoDevKey: clear }, UI);
      assert.equal(r.status, 200);
      assert.equal(r.payload.logoDevKey, null);
      assert.deepEqual(configFile().genui, {});
    }
  });

  it("refuses a secret key, a bad level and unknown fields", async () => {
    const { c, store, configFile } = makeContainer();
    for (const body of [{ logoDevKey: "sk_live_123456" }, { level: "loud" }, { level: "rich", typo: 1 }]) {
      const r = await call(c, "PUT", ROUTES.settingsGenui, body, UI);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.deepEqual(store, {});
    assert.equal(configFile().genui, undefined);
  });
});

describe("PUT /api/settings", () => {
  it("never turns location sharing on — that is PUT /api/settings/genui's", async () => {
    const { c, store } = makeContainer();
    const r = await call(c, "PUT", ROUTES.settings, { settings: { "location.share": true, theme: "dark" } });
    assert.equal(r.status, 403);
    assert.match(r.payload.error, /location\.share is set only through \/api\/settings\/genui/);
    assert.deepEqual(store, {}, "nothing from the refused patch lands");
  });

  it("refuses the genui level and the apps switch too — an agent can't undo the user's choice", async () => {
    const { c, store } = makeContainer();
    for (const settings of [{ "genui.level": "rich" }, { "genui.apps": true, theme: "dark" }]) {
      const r = await call(c, "PUT", ROUTES.settings, { settings });
      assert.equal(r.status, 403);
      assert.match(r.payload.error, /set only through \/api\/settings\/genui/);
    }
    assert.deepEqual(store, {});
  });

  it("still writes everything else", async () => {
    const { c, store } = makeContainer();
    const r = await call(c, "PUT", ROUTES.settings, { settings: { theme: "dark" } });
    assert.equal(r.status, 200);
    assert.deepEqual(store, { theme: "dark" });
  });
});
