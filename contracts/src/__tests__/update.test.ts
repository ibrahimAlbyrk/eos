import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SignedUpdatePointerSchema, UpdateCheckRequestSchema, UpdateManifestSchema, UpdatePointerSchema } from "../update.ts";

const pointer = {
  version: "0.1.3",
  platform: "darwin-arm64",
  manifest: { path: "releases/0.1.3/darwin-arm64.manifest.json.zst", sha256: "a".repeat(64), size: 1234 },
  notes: "notes/0.1.3.md",
  releasedAt: "2026-10-29T18:43:00Z",
};

describe("update contracts", () => {
  it("parses a pointer and refuses one that leaves the feed", () => {
    assert.equal(UpdatePointerSchema.safeParse(pointer).success, true);
    for (const path of ["../x", "releases/../../etc", "https://evil.example/m", "/abs"]) {
      assert.equal(UpdatePointerSchema.safeParse({ ...pointer, manifest: { ...pointer.manifest, path } }).success, false, path);
    }
    assert.equal(UpdatePointerSchema.safeParse({ ...pointer, version: "0.1" }).success, false);
  });

  it("moves the feed only to another https address", () => {
    assert.equal(UpdatePointerSchema.safeParse({ ...pointer, feedUrl: "https://updates.example.dev" }).success, true);
    assert.equal(UpdatePointerSchema.safeParse({ ...pointer, feedUrl: "http://updates.example.dev" }).success, false);
  });

  it("carries an Ed25519 signature as 64 bytes of base64", () => {
    const signature = Buffer.alloc(64, 7).toString("base64");
    assert.equal(SignedUpdatePointerSchema.safeParse({ payload: JSON.stringify(pointer), signature }).success, true);
    assert.equal(SignedUpdatePointerSchema.safeParse({ payload: "{}", signature: signature.slice(4) }).success, false);
  });

  it("treats a check with no trigger as Check now", () => {
    assert.deepEqual(UpdateCheckRequestSchema.parse({}), { trigger: "manual" });
    assert.deepEqual(UpdateCheckRequestSchema.parse({ trigger: "woke" }), { trigger: "woke" });
    assert.equal(UpdateCheckRequestSchema.safeParse({ trigger: "hourly" }).success, false);
  });

  it("parses a manifest's three entry kinds", () => {
    const manifest = {
      format: 1, version: "0.1.3", platform: "darwin-arm64",
      packs: ["packs/darwin-arm64/0.1.3.pack"],
      chunks: [{ id: "b".repeat(64), size: 10, pack: 0, offset: 0, zsize: 8 }],
      entries: [
        { type: "dir", path: "Contents", mode: 0o755 },
        { type: "link", path: "Contents/Current", target: "A" },
        { type: "file", path: "Contents/Info.plist", mode: 0o644, size: 10, sha256: "c".repeat(64), chunks: [0] },
      ],
    };
    assert.equal(UpdateManifestSchema.safeParse(manifest).success, true);
    assert.equal(UpdateManifestSchema.safeParse({ ...manifest, format: 2 }).success, false);
  });
});
