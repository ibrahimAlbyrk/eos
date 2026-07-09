import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Router } from "../Router.ts";
import { registerRemoteRoutes } from "../remote.ts";
import { makeRouteDispatch } from "../../remote/virtual-dispatch.ts";
import type { RemoteGatewayHandle } from "../../remote/wire.ts";
import type { PairingQr } from "../../../contracts/src/remote.ts";

const QR: PairingQr = {
  v: 3, typ: "eos-pair",
  relay: "wss://r/",
  room: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", // >=43 b64url chars
  bearer: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  exp: 1,
};

function setup(gateway: RemoteGatewayHandle | null, enabled = true) {
  const router = new Router();
  registerRemoteRoutes(router, {
    uiToken: "TOK",
    getConfig: () => ({ remote: { enabled, relay: { url: "wss://r/" } }, daemon: { port: 7400 } }),
    getGateway: () => gateway,
    arm: () => ({ enabled, armed: gateway != null }),
  });
  return makeRouteDispatch(router);
}

const armed = (): RemoteGatewayHandle => ({
  stop() {}, armPairing: () => QR,
});

describe("remote pairing-arm routes (v3)", () => {
  it("GET /api/remote/status requires the ui-token and returns { enabled, armed }", async () => {
    const d = setup(armed());
    assert.equal((await d({ method: "GET", path: "/api/remote/status", body: {} })).status, 403);
    const ok = await d({ method: "GET", path: "/api/remote/status", body: {}, uiToken: "TOK" });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { enabled: true, armed: true });
  });

  it("POST /api/remote/pair: 403 without token, 409 unarmed, v3 QR when armed", async () => {
    assert.equal((await setup(armed())({ method: "POST", path: "/api/remote/pair", body: {} })).status, 403);

    const unarmed = await setup(null, false)({ method: "POST", path: "/api/remote/pair", body: {}, uiToken: "TOK" });
    assert.equal(unarmed.status, 409);

    const ok = await setup(armed())({ method: "POST", path: "/api/remote/pair", body: {}, uiToken: "TOK" });
    assert.equal(ok.status, 200);
    assert.equal((ok.body as PairingQr).v, 3);
    assert.equal((ok.body as PairingQr).typ, "eos-pair");
    assert.equal((ok.body as PairingQr).relay, "wss://r/");
  });

  it("POST /api/remote/arm: 403 without token, returns { enabled, armed } with token", async () => {
    assert.equal((await setup(armed())({ method: "POST", path: "/api/remote/arm", body: {} })).status, 403);

    const on = await setup(armed(), true)({ method: "POST", path: "/api/remote/arm", body: {}, uiToken: "TOK" });
    assert.equal(on.status, 200);
    assert.deepEqual(on.body, { enabled: true, armed: true });

    const off = await setup(null, false)({ method: "POST", path: "/api/remote/arm", body: {}, uiToken: "TOK" });
    assert.equal(off.status, 200);
    assert.deepEqual(off.body, { enabled: false, armed: false });
  });
});
