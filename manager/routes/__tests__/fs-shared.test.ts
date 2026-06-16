import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWithinRoot } from "../fs-shared.ts";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("resolves a path inside the root", () => {
  const root = tmp("eos-rwr-");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.txt"), "x");
  assert.equal(resolveWithinRoot(root, "src/a.txt"), join(realpathSync(root), "src", "a.txt"));
  rmSync(root, { recursive: true, force: true });
});

test("target equal to root returns the root", () => {
  const root = tmp("eos-rwr-");
  assert.equal(resolveWithinRoot(root, "."), realpathSync(root));
  rmSync(root, { recursive: true, force: true });
});

test("rejects .. escape (lexical and mid-path)", () => {
  const root = tmp("eos-rwr-");
  mkdirSync(join(root, "src"));
  assert.equal(resolveWithinRoot(root, "../outside"), null);
  assert.equal(resolveWithinRoot(root, "src/../../escape"), null);
  rmSync(root, { recursive: true, force: true });
});

test("rejects an absolute target outside the root", () => {
  const root = tmp("eos-rwr-");
  assert.equal(resolveWithinRoot(root, "/etc/passwd"), null);
  rmSync(root, { recursive: true, force: true });
});

test("rejects a symlink that escapes the root", () => {
  const root = tmp("eos-rwr-");
  const outside = tmp("eos-out-");
  symlinkSync(outside, join(root, "escape"));
  assert.equal(resolveWithinRoot(root, "escape"), null);
  assert.equal(resolveWithinRoot(root, "escape/secret.txt"), null);
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("allows a not-yet-existing path inside the root (create/mkdir)", () => {
  const root = tmp("eos-rwr-");
  mkdirSync(join(root, "src"));
  assert.equal(resolveWithinRoot(root, "src/new-file.txt"), join(realpathSync(root), "src", "new-file.txt"));
  rmSync(root, { recursive: true, force: true });
});

test("rejects non-string and null-byte inputs", () => {
  const root = tmp("eos-rwr-");
  assert.equal(resolveWithinRoot(root, undefined), null);
  assert.equal(resolveWithinRoot(undefined, "x"), null);
  assert.equal(resolveWithinRoot(root, "a\0b"), null);
  rmSync(root, { recursive: true, force: true });
});
