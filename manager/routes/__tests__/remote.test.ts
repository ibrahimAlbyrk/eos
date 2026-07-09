import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Router } from "../Router.ts";
import { registerRemoteRoutes } from "../remote.ts";
import { makeRouteDispatch } from "../../remote/virtual-dispatch.ts";
import type { RemoteGatewayHandle } from "../../remote/wire.ts";
import type { RemoteConfig, PairingQr } from "../../../contracts/src/remote.ts";

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
    getConfig: () => ({ remote: { enabled, relay: { url: "wss://r/" } }, daemon: { port: 7400, home: tmpdir() } }),
    getGateway: () => gateway,
    arm: () => ({ enabled, armed: gateway != null }),
    reloadConfig: () => {},
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

  it("PUT /api/remote/config: 403 without token; field-merges the patch into config.json + reloads", async () => {
    const home = mkdtempSync(join(tmpdir(), "eos-remote-"));
    // Seed config.json with a lease so the merge is asserted to PRESERVE it.
    const cfgPath = join(home, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ remote: { enabled: false, inactivityLeaseMs: 42 } }, null, 2));

    let reloads = 0;
    const router = new Router();
    registerRemoteRoutes(router, {
      uiToken: "TOK",
      // getConfig reads live from disk so the response reflects the saved value.
      getConfig: () => ({
        remote: (JSON.parse(readFileSync(cfgPath, "utf8")).remote ?? {}) as RemoteConfig,
        daemon: { port: 7400, home },
      }),
      getGateway: () => null,
      arm: () => ({ enabled: false, armed: false }),
      reloadConfig: () => { reloads += 1; },
    });
    const d = makeRouteDispatch(router);

    const body = { enabled: true, relay: { url: "wss://relay.example.com/" } };
    assert.equal((await d({ method: "PUT", path: "/api/remote/config", body })).status, 403);

    const ok = await d({ method: "PUT", path: "/api/remote/config", body, uiToken: "TOK" });
    assert.equal(ok.status, 200);
    assert.deepEqual((ok.body as { remote: RemoteConfig }).remote, {
      enabled: true,
      relay: { url: "wss://relay.example.com/" },
      inactivityLeaseMs: 42, // preserved by the field-merge
    });
    assert.equal(reloads, 1);

    // The write actually persisted to disk.
    assert.equal(existsSync(cfgPath), true);
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, "utf8")).remote, {
      enabled: true,
      relay: { url: "wss://relay.example.com/" },
      inactivityLeaseMs: 42,
    });
  });

  it("PUT /api/remote/config: 403 gates before validation; validate() rejects unknown key + bad relay url", async () => {
    const d = setup(null, false);
    // Token gate runs first — a bad body without the token is still a 403, never
    // a validation error (the handler returns before readBody/validate).
    assert.equal((await d({ method: "PUT", path: "/api/remote/config", body: { bogus: 1 } })).status, 403);

    // With the token, validate() throws ValidationError (strict + url check). The
    // virtual-dispatch shim doesn't apply the central error handler (that maps it
    // to 400 on the real HTTP path), so assert the throw the handler produces.
    await assert.rejects(() => d({ method: "PUT", path: "/api/remote/config", body: { bogus: 1 }, uiToken: "TOK" }));
    await assert.rejects(() => d({ method: "PUT", path: "/api/remote/config", body: { relay: { url: "not-a-url" } }, uiToken: "TOK" }));
  });
});
