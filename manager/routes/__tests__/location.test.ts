import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Router, type RouteContext } from "../Router.ts";
import { registerLocationRoutes } from "../location.ts";
import { makeLocationSource, type AppHostLike } from "../../services/genui/media.ts";
import { LocationResponseSchema } from "../../../contracts/src/genui/spec.ts";
import { isLocalOnlyRoute } from "../../../contracts/src/route-planes.ts";

function fakeHost(opts: { connected: boolean; answer?: unknown; error?: { name: string; message: string } }) {
  const calls: Array<[string, string, unknown[]]> = [];
  const host: AppHostLike = {
    isRegistered: () => opts.connected,
    rpc: async (sessionKey, method, args) => {
      calls.push([sessionKey, method, args]);
      if (opts.error) throw Object.assign(new Error(opts.error.message), { name: opts.error.name });
      return opts.answer;
    },
  };
  return { host, calls };
}

const TOKEN = "ui-token-1";
const WORKERS: Record<string, { is_orchestrator?: number | null; agent_role?: string | null }> = {
  orch: { is_orchestrator: 1 },
  focus: { is_orchestrator: 0, agent_role: "focused" },
  worker: { is_orchestrator: 0, agent_role: null },
};
const AS_UI = { "x-eos-ui-token": TOKEN };

async function get(source: ReturnType<typeof makeLocationSource>, reqHeaders: Record<string, string> = AS_UI) {
  const router = new Router();
  registerLocationRoutes(router, { genuiMedia: { location: source }, uiToken: TOKEN, workers: { findById: (id) => WORKERS[id] ?? null } });
  const m = router.match("GET", "/api/location");
  assert.ok(m);
  let status = 0;
  let payload: Record<string, unknown> = {};
  const headers: Record<string, string> = {};
  const res = {
    req: { method: "GET", headers: {} },
    setHeader: (k: string, v: string) => { headers[k] = v; },
    getHeader: (k: string) => headers[k],
    writeHead: (s: number) => { status = s; },
    end: (b?: string) => { payload = b ? JSON.parse(b) : {}; },
  } as unknown as RouteContext["res"];
  await m.handler({ params: m.params, req: { headers: reqHeaders } as unknown as RouteContext["req"], res } as RouteContext);
  return { status, payload, headers };
}

const FIX = { lat: 40.98765, lon: 29.02345, accuracy: 35, at: 1_760_000_000_000 };
const settings = (share: unknown) => ({ read: () => (share === undefined ? {} : { "location.share": share }) });
const geocoder = { reverse: async () => ({ district: "Kadıköy", city: "İstanbul", country: "Türkiye" }) };

describe("GET /api/location", () => {
  it("is local-only in the route planes", () => {
    assert.equal(isLocalOnlyRoute("GET", "/api/location"), true);
  });

  it("answers only the dashboard, an orchestrator or a focused session — never a spawned worker or a stranger", async () => {
    const cases: Array<[Record<string, string>, number]> = [
      [AS_UI, 200],
      [{ "x-eos-agent-id": "orch" }, 200],
      [{ "x-eos-agent-id": "focus" }, 200],
      [{ "x-eos-agent-id": "worker" }, 403],
      [{ "x-eos-agent-id": "nobody" }, 403],
      [{ "x-eos-ui-token": "wrong" }, 403],
      [{}, 403],
    ];
    for (const [headers, status] of cases) {
      const { host, calls } = fakeHost({ connected: true, answer: FIX });
      const r = await get(makeLocationSource({ appHost: host, userSettings: settings(true), geocoder }), headers);
      assert.equal(r.status, status, JSON.stringify(headers));
      if (status === 403) {
        assert.equal(r.payload.code, "forbidden");
        assert.equal(calls.length, 0);
      }
    }
  });

  it("403s while sharing is off (the default), naming the setting — the app is never asked", async () => {
    for (const share of [undefined, false, "true"]) {
      const { host, calls } = fakeHost({ connected: true, answer: FIX });
      const r = await get(makeLocationSource({ appHost: host, userSettings: settings(share), geocoder }));
      assert.equal(r.status, 403);
      assert.equal(r.payload.code, "sharing-off");
      assert.match(String(r.payload.error), /Settings › General › Visual answers/);
      assert.equal(calls.length, 0);
    }
  });

  it("503s while the app isn't connected", async () => {
    const { host } = fakeHost({ connected: false });
    const r = await get(makeLocationSource({ appHost: host, userSettings: settings(true), geocoder }));
    assert.equal(r.status, 503);
    assert.equal(r.payload.code, "app-offline");
  });

  it("answers the app's fix with the reverse-geocoded area", async () => {
    const { host, calls } = fakeHost({ connected: true, answer: FIX });
    const r = await get(makeLocationSource({ appHost: host, userSettings: settings(true), geocoder }));
    assert.equal(r.status, 200);
    assert.deepEqual(calls, [["", "location.get", []]]);
    const body = LocationResponseSchema.parse(r.payload);
    assert.equal(body.lat, FIX.lat);
    assert.deepEqual(body.area, { district: "Kadıköy", city: "İstanbul", country: "Türkiye" });
    assert.equal(r.headers["cache-control"], "no-store");
  });

  it("still answers when the area lookup fails", async () => {
    const { host } = fakeHost({ connected: true, answer: FIX });
    const r = await get(makeLocationSource({ appHost: host, userSettings: settings(true), geocoder: { reverse: async () => { throw new Error("offline"); } } }));
    assert.equal(r.status, 200);
    assert.equal(r.payload.area, undefined);
  });

  it("maps the app's refusals to clear sentences", async () => {
    const cases: Array<[{ name: string; message: string }, number, string]> = [
      [{ name: "LocationDenied", message: "location access denied" }, 403, "denied"],
      [{ name: "LocationDisabled", message: "Location Services are off" }, 403, "disabled"],
      [{ name: "LocationTimeout", message: "no location within 25 s" }, 504, "timeout"],
      [{ name: "LocationUnavailable", message: "no fix" }, 503, "unavailable"],
      [{ name: "Error", message: "unknown browser method: location.get" }, 503, "unsupported"],
      [{ name: "Error", message: "browser host disconnected" }, 503, "app-offline"],
    ];
    for (const [error, status, code] of cases) {
      const { host } = fakeHost({ connected: true, error });
      const r = await get(makeLocationSource({ appHost: host, userSettings: settings(true), geocoder }));
      assert.equal(r.status, status, error.name);
      assert.equal(r.payload.code, code);
    }
    const bad = fakeHost({ connected: true, answer: { lat: "x" } });
    assert.equal((await get(makeLocationSource({ appHost: bad.host, userSettings: settings(true), geocoder }))).payload.code, "unsupported");
  });
});
