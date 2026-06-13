import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateBranchName } from "../domain/branch-name.ts";

describe("validateBranchName", () => {
  it("accepts ordinary branch names", () => {
    for (const ok of ["main", "feature/login", "release-2.0", "fix_123", "user/feat/x"]) {
      assert.equal(validateBranchName(ok).ok, true, ok);
    }
  });

  it("rejects empty / whitespace-only", () => {
    assert.equal(validateBranchName("").ok, false);
    assert.equal(validateBranchName("   ").ok, false);
  });

  it("rejects forbidden characters", () => {
    for (const bad of ["has space", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b"]) {
      assert.equal(validateBranchName(bad).ok, false, bad);
    }
  });

  it("rejects git ref-format edge cases", () => {
    for (const bad of ["/lead", "trail/", ".dot", "dot.", "feat.lock", "a..b", "a//b", "a@{b", "@"]) {
      assert.equal(validateBranchName(bad).ok, false, bad);
    }
  });

  it("trims surrounding whitespace before validating", () => {
    assert.equal(validateBranchName("  main  ").ok, true);
  });
});
