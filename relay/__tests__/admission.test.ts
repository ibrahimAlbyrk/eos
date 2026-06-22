import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256Hex, ownerHashMatches, bearerAllowed } from "../admission.ts";

test("sha256Hex matches node crypto for a known input", () => {
  const expected = createHash("sha256").update("hello").digest("hex");
  assert.equal(sha256Hex("hello"), expected);
});

test("ownerHashMatches accepts the right owner, rejects a wrong one", () => {
  const stored = sha256Hex("owner-secret");
  assert.equal(ownerHashMatches("owner-secret", stored), true);
  assert.equal(ownerHashMatches("not-it", stored), false);
});

test("bearerAllowed admits a member and denies a non-member", () => {
  const allow = new Set([sha256Hex("dev-A"), sha256Hex("dev-B")]);
  assert.equal(bearerAllowed("dev-A", allow), true);
  assert.equal(bearerAllowed("dev-B", allow), true);
  assert.equal(bearerAllowed("dev-C", allow), false);
});

test("bearerAllowed denies against an empty allowlist", () => {
  assert.equal(bearerAllowed("anything", new Set()), false);
});
