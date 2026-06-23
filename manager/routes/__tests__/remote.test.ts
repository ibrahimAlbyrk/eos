import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Router } from "../Router.ts";
import { registerRemoteRoutes } from "../remote.ts";
import { makeRouteDispatch } from "../../remote/virtual-dispatch.ts";
import type { RemoteGatewayHandle } from "../../remote/wire.ts";
import type { PairingQr } from "../../../contracts/src/remote.ts";

const QR: PairingQr = {
  v: 1, typ: "eos-pair", macPub: "mp", ots: "ot", otsExp: 1, lan: [],
  lanSpki: null, relay: { url: "wss://r/", room: "AAAAAAAAAAAAAAAAAAAAAA" }, bearer: "br", exp: 1,
};

function setup(gateway: RemoteGatewayHandle | null, mode: "off" | "lan" | "relay" = "relay") {
  const router = new Router();
  registerRemoteRoutes(router, {
    uiToken: "TOK",
    getConfig: () => ({ remote: { mode, relay: { url: "wss://r/", room: "AAAAAAAAAAAAAAAAAAAAAA" } }, daemon: { port: 7400 } }),
    getGateway: () => gateway,
    arm: () => ({ mode, armed: gateway != null }),
  });
  return makeRouteDispatch(router);
}

const armed = (): RemoteGatewayHandle => ({
  stop() {}, pairing: {} as never, armPairing: () => QR,
});

describe("remote pairing-arm routes", () => {
  it("GET /api/remote/status requires the ui-token", async () => {
    const d = setup(armed());
    assert.equal((await d({ method: "GET", path: "/api/remote/status", body: {} })).status, 403);
    const ok = await d({ method: "GET", path: "/api/remote/status", body: {}, uiToken: "TOK" });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { mode: "relay", armed: true });
  });

  it("POST /api/remote/pair: 403 without token, 409 unarmed, QR when armed", async () => {
    assert.equal((await setup(armed())({ method: "POST", path: "/api/remote/pair", body: {} })).status, 403);

    const unarmed = await setup(null)({ method: "POST", path: "/api/remote/pair", body: {}, uiToken: "TOK" });
    assert.equal(unarmed.status, 409);

    const ok = await setup(armed())({ method: "POST", path: "/api/remote/pair", body: {}, uiToken: "TOK" });
    assert.equal(ok.status, 200);
    assert.equal((ok.body as PairingQr).typ, "eos-pair");
    assert.equal((ok.body as PairingQr).relay?.room, "AAAAAAAAAAAAAAAAAAAAAA");
  });

  it("POST /api/remote/arm: 403 without token, returns {mode, armed} with token", async () => {
    assert.equal((await setup(armed())({ method: "POST", path: "/api/remote/arm", body: {} })).status, 403);

    const on = await setup(armed(), "relay")({ method: "POST", path: "/api/remote/arm", body: {}, uiToken: "TOK" });
    assert.equal(on.status, 200);
    assert.deepEqual(on.body, { mode: "relay", armed: true });

    const off = await setup(null, "off")({ method: "POST", path: "/api/remote/arm", body: {}, uiToken: "TOK" });
    assert.equal(off.status, 200);
    assert.deepEqual(off.body, { mode: "off", armed: false });
  });
});
