import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { Router } from "../../routes/Router.ts";
import { classifyTier } from "../tiers.ts";
import { makeRouteDispatch } from "../virtual-dispatch.ts";
import { ControlDispatcher, type DispatchSession } from "../dispatch.ts";
import { encodeServerFrame } from "../framer.ts";
import { Dir, parseEnvelope } from "../envelope.ts";
import type { RemoteAuditLog } from "../audit.ts";
import type { ServerFrame } from "../WsBridge.ts";
import { AssetFrameSchema, type ControlFrame } from "../../../contracts/src/remote.ts";

// Non-utf8 bytes (NUL + high bytes) — exactly what a utf-8 round-trip corrupts.
const BIN = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0x01, 0x02]);

const noAudit = { append() {} } as unknown as RemoteAuditLog;
const fullSession: DispatchSession = { devId: "dev-1", hasCap: () => true };
const ctl = (method: ControlFrame["method"], path: string): ControlFrame => ({
  t: "control", correlationId: "11111111-1111-4111-8111-111111111111", method, path,
});

describe("tier reclassification — only the three asset reads move to READ (C6)", () => {
  it("classifies the three pure-read asset routes as READ", () => {
    assert.equal(classifyTier("GET", "/fs/raw/Users/me/pic.png").tier, "READ");
    assert.equal(classifyTier("GET", "/fs/raw/a/b/c/deep/nested/file.bin").tier, "READ"); // multi-segment
    assert.equal(classifyTier("GET", "/fs/image?path=/a/b.png").tier, "READ");
    assert.equal(classifyTier("GET", "/pdfjs").tier, "READ");
    assert.equal(classifyTier("GET", "/pdfjs/web/viewer.html?file=/x.pdf").tier, "READ");
  });

  it("loosens nothing else — mutating routes and the rest of REFUSED are unchanged", () => {
    assert.equal(classifyTier("POST", "/fs/write").tier, "HIGH");
    assert.equal(classifyTier("POST", "/fs/paste").tier, "HIGH");
    assert.equal(classifyTier("POST", "/fs/create").tier, "HIGH");
    assert.equal(classifyTier("GET", "/stream").tier, "REFUSED");
    assert.equal(classifyTier("GET", "/pick-file").tier, "REFUSED");
    assert.equal(classifyTier("POST", "/workers/abc/events").tier, "REFUSED");
    // Bare /fs/raw has no sub-path — not a real route, stays fail-closed REFUSED.
    assert.equal(classifyTier("GET", "/fs/raw").tier, "REFUSED");
  });
});

describe("makeRouteDispatch — binary capture without utf-8 corruption (C6)", () => {
  it("captures a single-buffer binary response (res.end(buffer)) as binary + mime", async () => {
    const r = new Router();
    r.get("/fs/image", ({ res }) => { res.writeHead(200, { "content-type": "image/png" }); res.end(BIN); });
    const out = await makeRouteDispatch(r)({ method: "GET", path: "/fs/image?path=/x.png", body: {} });
    assert.ok("binary" in out, "non-JSON response must be carried as binary");
    if ("binary" in out) {
      assert.equal(out.status, 200);
      assert.equal(out.binary.mime, "image/png");
      assert.deepEqual(out.binary.bytes, BIN);
    }
  });

  it("waits for a STREAMING handler (createReadStream().pipe(res)) and captures intact bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eos-asset-"));
    try {
      const file = join(dir, "blob.bin");
      writeFileSync(file, BIN);
      const r = new Router();
      // Mirrors fs-raw's serveFile: the handler returns BEFORE the pipe finishes.
      r.get(/^\/fs\/raw(?<rest>\/.+)$/, ({ res }) => {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        createReadStream(file).pipe(res as never);
      });
      const out = await makeRouteDispatch(r)({ method: "GET", path: "/fs/raw" + file, body: {} });
      assert.ok("binary" in out, "streamed bytes must be captured, not dropped");
      if ("binary" in out) assert.deepEqual(out.binary.bytes, BIN);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("still returns JSON routes as a parsed body (control plane unchanged)", async () => {
    const r = new Router();
    r.get("/health", ({ res }) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); });
    const out = await makeRouteDispatch(r)({ method: "GET", path: "/health", body: {} });
    assert.ok(!("binary" in out));
    if (!("binary" in out)) assert.deepEqual(out.body, { ok: true });
  });
});

describe("ControlDispatcher — frames binary as `asset`, oversize as FRAME_TOO_LARGE (C6)", () => {
  it("emits the frozen asset frame with intact base64 bytes + mime + correlationId", async () => {
    const d = new ControlDispatcher({
      routeDispatch: async () => ({ status: 200, binary: { mime: "image/png", bytes: BIN } }),
      audit: noAudit, uiToken: "tok", now: () => 0,
    });
    const reply = await d.handle(fullSession, ctl("GET", "/fs/image?path=/x.png"));
    assert.equal(reply.t, "asset");
    if (reply.t === "asset") {
      assert.equal(reply.correlationId, "11111111-1111-4111-8111-111111111111");
      assert.equal(reply.status, 200);
      assert.equal(reply.mime, "image/png");
      assert.deepEqual(Buffer.from(reply.bytesB64, "base64"), BIN); // NOT a corrupted utf8 string
    }
  });

  it("fails closed with FRAME_TOO_LARGE when base64 would exceed the relay envelope", async () => {
    const huge = Buffer.alloc(Math.floor(4.5 * 1024 * 1024), 0x41); // base64 ~6 MiB > 5 MiB cap
    const d = new ControlDispatcher({
      routeDispatch: async () => ({ status: 200, binary: { mime: "application/pdf", bytes: huge } }),
      audit: noAudit, uiToken: "tok", now: () => 0,
    });
    const reply = await d.handle(fullSession, ctl("GET", "/pdfjs/web/viewer.pdf"));
    assert.equal(reply.t, "error");
    if (reply.t === "error") assert.equal(reply.code, "FRAME_TOO_LARGE");
  });

  it("still emits a JSON reply frame for non-binary routes", async () => {
    const d = new ControlDispatcher({
      routeDispatch: async () => ({ status: 200, body: { workers: [] } }),
      audit: noAudit, uiToken: "tok", now: () => 0,
    });
    const reply = await d.handle(fullSession, ctl("GET", "/workers"));
    assert.equal(reply.t, "reply");
    if (reply.t === "reply") assert.deepEqual(reply.body, { workers: [] });
  });
});

describe("asset frame round-trips through the plaintext framer (C6)", () => {
  it("frames s2c and re-parses to the exact bytes the device will decode", () => {
    const clientId = randomBytes(16);
    const room = "asset-room";
    const frame: ServerFrame = { t: "asset", correlationId: "c-9", status: 200, mime: "image/png", bytesB64: BIN.toString("base64") };
    const env = parseEnvelope(encodeServerFrame({ room, clientId, frame }));
    assert.equal(env.dir, Dir.s2c);
    // Plaintext payload — no key needed. The device reads the raw JSON directly.
    const decoded = AssetFrameSchema.parse(JSON.parse(env.payload.toString("utf8")));
    assert.equal(decoded.mime, "image/png");
    assert.deepEqual(Buffer.from(decoded.bytesB64, "base64"), BIN);
  });
});
