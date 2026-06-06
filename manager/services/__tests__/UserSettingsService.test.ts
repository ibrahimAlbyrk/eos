import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UserSettingsService } from "../UserSettingsService.ts";

describe("UserSettingsService", () => {
  let dir: string;
  let svc: UserSettingsService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "settings-test-"));
    svc = new UserSettingsService(join(dir, "settings.json"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads empty when file does not exist", () => {
    assert.deepEqual(svc.read(), {});
  });

  it("patch + read roundtrips values of every supported type", () => {
    svc.patch({ "a.flag": true, "a.text": "hello", "a.num": 3 });
    assert.deepEqual(svc.read(), { "a.flag": true, "a.text": "hello", "a.num": 3 });
  });

  it("patch merges shallowly and preserves unrelated keys", () => {
    svc.patch({ "a.flag": true, "b.keep": "yes" });
    const merged = svc.patch({ "a.flag": false });
    assert.deepEqual(merged, { "a.flag": false, "b.keep": "yes" });
    assert.deepEqual(svc.read(), merged);
  });

  it("creates missing parent directories on patch", () => {
    const nested = new UserSettingsService(join(dir, "deep", "down", "settings.json"));
    nested.patch({ k: 1 });
    assert.deepEqual(nested.read(), { k: 1 });
  });

  it("falls back to empty on corrupt json", () => {
    writeFileSync(join(dir, "settings.json"), "{not json");
    assert.deepEqual(svc.read(), {});
  });

  it("falls back to empty on schema-invalid content", () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ bad: { nested: true } }));
    assert.deepEqual(svc.read(), {});
  });

  it("written file is pretty-printed json with trailing newline", () => {
    svc.patch({ k: true });
    const raw = readFileSync(join(dir, "settings.json"), "utf8");
    assert.equal(raw, `{\n  "k": true\n}\n`);
  });
});
