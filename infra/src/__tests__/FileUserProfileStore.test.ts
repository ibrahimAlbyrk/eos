import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileUserAvatarStore, FileUserProfileStore } from "../persistence/FileUserProfileStore.ts";
import { emptyUserProfile } from "../../../core/src/domain/user-profile.ts";

describe("FileUserProfileStore", () => {
  it("null until saved, then round-trips through profile.json across instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-"));
    assert.equal(new FileUserProfileStore(dir).get(), null);
    const p = { ...emptyUserProfile(), rev: 2, instructions: "Use pnpm." };
    new FileUserProfileStore(dir).put(p);
    assert.deepEqual(new FileUserProfileStore(dir).get(), p);
  });

  it("an invalid file reads as never saved", () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-"));
    writeFileSync(join(dir, "profile.json"), "{ not json");
    assert.equal(new FileUserProfileStore(dir).get(), null);
    writeFileSync(join(dir, "profile.json"), JSON.stringify({ rev: "x" }));
    assert.equal(new FileUserProfileStore(dir).get(), null);
  });

  it("refuses to write an invalid profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-"));
    assert.throws(() => new FileUserProfileStore(dir).put({ ...emptyUserProfile(), budgetTokens: 1 }));
  });
});

describe("FileUserAvatarStore", () => {
  it("one avatar at a time, whatever its type", () => {
    const dir = mkdtempSync(join(tmpdir(), "avatar-"));
    const store = new FileUserAvatarStore(dir);
    assert.equal(store.read(), null);
    store.write({ bytes: new Uint8Array([1, 2]), ext: "png" });
    store.write({ bytes: new Uint8Array([3]), ext: "webp" });
    assert.ok(!existsSync(join(dir, "avatar.png")));
    const a = store.read();
    assert.equal(a?.ext, "webp");
    assert.deepEqual([...(a?.bytes ?? [])], [3]);
    store.remove();
    assert.equal(store.read(), null);
  });
});
