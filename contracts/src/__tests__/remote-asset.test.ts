import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AssetFrameSchema } from "../remote.ts";

describe("AssetFrameSchema (C6 binary out-of-band)", () => {
  it("accepts the frozen asset-frame shape and round-trips non-utf8 bytes via base64", () => {
    // Bytes that would be mangled by a utf-8 round-trip: a NUL and high bytes.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80, 0x01]);
    const frame = {
      t: "asset",
      correlationId: "corr-1",
      status: 200,
      mime: "image/png",
      bytesB64: bytes.toString("base64"),
    };
    const parsed = AssetFrameSchema.parse(frame);
    assert.equal(parsed.t, "asset");
    assert.equal(parsed.correlationId, "corr-1");
    assert.equal(parsed.status, 200);
    assert.equal(parsed.mime, "image/png");
    assert.deepEqual(Buffer.from(parsed.bytesB64, "base64"), bytes);
  });

  it("rejects a wrong discriminant or a missing field (shape is frozen)", () => {
    assert.equal(AssetFrameSchema.safeParse({ t: "reply", correlationId: "c", status: 200, mime: "x", bytesB64: "" }).success, false);
    assert.equal(AssetFrameSchema.safeParse({ t: "asset", correlationId: "c", status: 200, mime: "x" }).success, false);
    assert.equal(AssetFrameSchema.safeParse({ t: "asset", correlationId: "c", status: "200", mime: "x", bytesB64: "" }).success, false);
  });
});
