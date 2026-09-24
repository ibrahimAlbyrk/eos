import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonProjectsRepo } from "../persistence/JsonProjectsRepo.ts";

test("upsert creates with a minted id, updates in place, survives reload", () => {
  const file = join(mkdtempSync(join(tmpdir(), "eos-projects-")), "projects.json");
  const repo = new JsonProjectsRepo(file);
  const created = repo.upsert({ name: "Demo", folders: ["/a", "/b", "/a"] });
  assert.ok(created.id);
  assert.deepEqual(created.folders, ["/a", "/b"]);

  repo.upsert({ ...created, name: "Renamed", folders: ["/b", "/a"], icon: { kind: "emoji", value: "🚀" } });
  const reloaded = new JsonProjectsRepo(file).list();
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0]!.name, "Renamed");
  assert.deepEqual(reloaded[0]!.folders, ["/b", "/a"]);
});

test("remove returns the removed project; unknown id is null", () => {
  const repo = new JsonProjectsRepo(join(mkdtempSync(join(tmpdir(), "eos-projects-")), "projects.json"));
  const p = repo.upsert({ name: "X", folders: ["/x"] });
  assert.equal(repo.remove("nope"), null);
  assert.equal(repo.remove(p.id)?.id, p.id);
  assert.deepEqual(repo.list(), []);
});

test("invalid entries on disk are dropped, valid ones kept", () => {
  const file = join(mkdtempSync(join(tmpdir(), "eos-projects-")), "projects.json");
  writeFileSync(file, JSON.stringify([{ id: "ok", name: "Ok", folders: ["/ok"] }, { id: "bad", folders: [] }]));
  assert.deepEqual(new JsonProjectsRepo(file).list().map((p) => p.id), ["ok"]);
});
