import { test } from "node:test";
import assert from "node:assert/strict";
import { additionalDirsFor } from "../domain/projects.ts";

const projects = [
  { id: "a", name: "A", folders: ["/a", "/shared-lib"] },
  { id: "b", name: "B", folders: ["/b"] },
];

test("additionalDirsFor: the owning project's other folders", () => {
  assert.deepEqual(additionalDirsFor(projects, ["/a"]), ["/shared-lib"]);
  assert.deepEqual(additionalDirsFor(projects, ["/shared-lib"]), ["/a"]);
});

test("additionalDirsFor: a worktree worker matches on its source repo", () => {
  assert.deepEqual(additionalDirsFor(projects, ["/wt/a-123", "/a"]), ["/shared-lib"]);
});

test("additionalDirsFor: empty for unowned or single-folder projects", () => {
  assert.deepEqual(additionalDirsFor(projects, ["/elsewhere", undefined, null]), []);
  assert.deepEqual(additionalDirsFor(projects, ["/b"]), []);
});
