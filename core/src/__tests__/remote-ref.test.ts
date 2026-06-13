import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isRemoteBranch, stripRemotePrefix } from "../domain/remote-ref.ts";

const remotes = ["origin", "upstream"];

describe("isRemoteBranch", () => {
  it("detects a remote-tracking ref", () => {
    assert.equal(isRemoteBranch("origin/main", remotes), true);
    assert.equal(isRemoteBranch("upstream/feature/x", remotes), true);
  });

  it("treats a local branch as not-remote", () => {
    assert.equal(isRemoteBranch("main", remotes), false);
    assert.equal(isRemoteBranch("feature/x", remotes), false);
  });
});

describe("stripRemotePrefix", () => {
  it("strips the matching remote prefix", () => {
    assert.equal(stripRemotePrefix("origin/main", remotes), "main");
    assert.equal(stripRemotePrefix("upstream/feature/x", remotes), "feature/x");
  });

  it("keeps slashes beyond the remote name", () => {
    assert.equal(stripRemotePrefix("origin/feature/deep/x", remotes), "feature/deep/x");
  });

  it("leaves a local branch untouched", () => {
    assert.equal(stripRemotePrefix("main", remotes), "main");
    assert.equal(stripRemotePrefix("feature/x", remotes), "feature/x");
  });

  it("strips the most specific remote when names overlap", () => {
    assert.equal(stripRemotePrefix("origin/x", ["orig", "origin"]), "x");
  });
});
