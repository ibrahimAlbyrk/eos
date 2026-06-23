import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Router } from "../../routes/Router.ts";
import { readBody } from "../../middleware/bodyReader.ts";
import { writeJson } from "../../middleware/errorHandler.ts";
import { makeRouteDispatch } from "../virtual-dispatch.ts";
import { generatePairing } from "../qr.ts";
import { MacIdentity } from "../keyring.ts";
import { PairingQrSchema } from "../../../contracts/src/remote.ts";

describe("makeRouteDispatch (virtual req/res into the real Router)", () => {
  function router(): Router {
    const r = new Router();
    r.get("/workers", ({ res }) => writeJson(res, 200, [{ id: "w1" }]));
    // $-anchored regex like the real /workers/:id/events route — exercises query matching.
    r.get(/^\/workers\/(?<id>[^/]+)\/events$/, ({ res, params, url }) =>
      writeJson(res, 200, { id: params.id, limit: url.searchParams.get("limit"), order: url.searchParams.get("order") }));
    r.post(/^\/workers\/(?<id>[^/]+)\/message$/, async ({ req, res, params }) => {
      const body = await readBody(req);
      writeJson(res, 200, { delivered: params.id, text: body.text, token: req.headers["x-eos-ui-token"] ?? null });
    });
    return r;
  }

  // Regression: a query-bearing READ over the control shim (e.g. the iOS transcript
  // pull GET /workers/:id/events?limit=…&order=…) must match the $-anchored route
  // and expose the query via url.searchParams — not 404 on the raw path+query.
  it("matches a $-anchored route when the path carries a query string", async () => {
    const dispatch = makeRouteDispatch(router());
    const r = await dispatch({ method: "GET", path: "/workers/w1/events?limit=500&order=desc", body: {} });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { id: "w1", limit: "500", order: "desc" });
  });

  it("dispatches a GET and returns the parsed JSON body + status", async () => {
    const dispatch = makeRouteDispatch(router());
    const r = await dispatch({ method: "GET", path: "/workers", body: {} });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, [{ id: "w1" }]);
  });

  it("streams the POST body in and passes the supplied ui-token header", async () => {
    const dispatch = makeRouteDispatch(router());
    const r = await dispatch({ method: "POST", path: "/workers/abc/message", body: { text: "hi" }, uiToken: "TOK" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { delivered: "abc", text: "hi", token: "TOK" });
  });

  it("omits the ui-token header when none is supplied", async () => {
    const dispatch = makeRouteDispatch(router());
    const r = await dispatch({ method: "POST", path: "/workers/abc/message", body: { text: "x" } });
    assert.equal((r.body as { token: unknown }).token, null);
  });

  it("returns 404 for an unmatched route", async () => {
    const r = await makeRouteDispatch(router())({ method: "GET", path: "/nope", body: {} });
    assert.equal(r.status, 404);
  });
});

describe("generatePairing (§6 QR)", () => {
  it("produces a schema-valid single-use offer with secrets held back", () => {
    const dir = mkdtempSync(join(tmpdir(), "eos-qr-"));
    try {
      const identity = new MacIdentity(dir);
      const offer = generatePairing({
        identity, now: 1_000_000,
        lan: ["wss://192.168.1.42:7400/ws"], lanSpki: "abc",
        relay: { url: "wss://relay.example:443", room: "AAAAAAAAAAAAAAAAAAAAAA" },
      });
      assert.doesNotThrow(() => PairingQrSchema.parse(offer.qr));
      assert.equal(offer.qr.macPub, identity.publicSec1().toString("base64url"));
      assert.equal(offer.ots.length, 32);
      assert.equal(offer.bearer.length, 32);
      // The QR carries b64u of the secrets; the raw bytes stay server-side.
      assert.equal(offer.qr.ots, offer.ots.toString("base64url"));
      assert.equal(offer.qr.otsExp, 1000 + 120); // now+120s in unix seconds
      // Two offers never share an ots (single-use).
      const other = generatePairing({ identity, now: 1_000_000 });
      assert.notEqual(offer.qr.ots, other.qr.ots);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
