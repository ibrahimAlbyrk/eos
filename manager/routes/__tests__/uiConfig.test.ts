import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterBackendProfiles, readOnDiskBackendKeys } from "../uiConfig.ts";

// The merged set the picker starts from: shipped DEFAULT_BACKENDS plus the operator's
// own. Only `name` matters to the filter.
const merged = [
  { name: "claude-sdk-opus" },
  { name: "claude-cli-opus" },
  { name: "claude-cli-sonnet" },
  { name: "claude-cli-haiku" },
  { name: "a" },
  { name: "b" },
];

describe("filterBackendProfiles", () => {
  it("on-disk backends {a,b} → lists only {a,b}, dropping the DEFAULT_BACKENDS clutter", () => {
    const out = filterBackendProfiles(merged, new Set(["a", "b"]));
    assert.deepEqual(out.map((p) => p.name), ["a", "b"]);
  });

  it("empty on-disk (null) → falls back to the full merged set", () => {
    assert.deepEqual(filterBackendProfiles(merged, null).map((p) => p.name), merged.map((p) => p.name));
  });

  it("empty on-disk (empty set) → falls back to the full merged set", () => {
    assert.deepEqual(filterBackendProfiles(merged, new Set()).map((p) => p.name), merged.map((p) => p.name));
  });
});

describe("readOnDiskBackendKeys", () => {
  const dir = mkdtempSync(join(tmpdir(), "eos-uiconfig-"));
  const write = (obj: unknown) => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify(obj));
    return p;
  };

  it("returns the operator's backend keys when present", () => {
    const keys = readOnDiskBackendKeys(write({ backends: { a: {}, b: {} } }));
    assert.deepEqual([...(keys ?? [])].sort(), ["a", "b"]);
  });

  it("returns null for a missing file", () => {
    assert.equal(readOnDiskBackendKeys(join(dir, "nope.json")), null);
  });

  it("returns null when the config declares no backends", () => {
    assert.equal(readOnDiskBackendKeys(write({ prices: {} })), null);
  });

  it("returns null for an empty backends object", () => {
    assert.equal(readOnDiskBackendKeys(write({ backends: {} })), null);
  });

  it("returns null for unreadable/invalid JSON", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{not json");
    assert.equal(readOnDiskBackendKeys(p), null);
    rmSync(dir, { recursive: true, force: true });
  });
});
