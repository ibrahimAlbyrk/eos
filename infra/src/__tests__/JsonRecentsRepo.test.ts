import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonRecentsRepo } from "../persistence/JsonRecentsRepo.ts";

test("list hides folders deleted since they were pushed, shows them again once recreated", () => {
  const root = mkdtempSync(join(tmpdir(), "eos-recents-"));
  const kept = join(root, "kept");
  const gone = join(root, "gone");
  mkdirSync(kept);
  mkdirSync(gone);
  const repo = new JsonRecentsRepo(join(root, "recents.json"));
  repo.push(kept);
  repo.push(gone);

  rmSync(gone, { recursive: true });
  assert.deepEqual(repo.list(), [kept]);
  assert.deepEqual(new JsonRecentsRepo(join(root, "recents.json")).list(), [kept]);

  mkdirSync(gone);
  assert.deepEqual(repo.list(), [gone, kept]);
});
