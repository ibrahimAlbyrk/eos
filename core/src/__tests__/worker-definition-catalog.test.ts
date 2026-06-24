import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeAvailableWorkers } from "../domain/worker-definition-catalog.ts";
import type { WorkerDefinitionRecord } from "../../../contracts/src/worker-definition.ts";

const rec = (
  name: string,
  source: WorkerDefinitionRecord["source"],
  whenToUse = "",
): WorkerDefinitionRecord => ({ name, description: "", whenToUse, body: "", source });

describe("mergeAvailableWorkers", () => {
  it("empty inputs → empty list", () => {
    assert.deepEqual(mergeAvailableWorkers([], []), []);
  });

  it("disk-only passes through in order", () => {
    const disk = [rec("general-purpose", "builtin"), rec("git", "builtin")];
    assert.deepEqual(
      mergeAvailableWorkers(disk, []).map((r) => r.name),
      ["general-purpose", "git"],
    );
  });

  it("runtime-only definitions append in order", () => {
    const runtime = [rec("a", "runtime"), rec("b", "runtime")];
    assert.deepEqual(
      mergeAvailableWorkers([], runtime).map((r) => r.name),
      ["a", "b"],
    );
  });

  it("runtime wins on a name clash but keeps the disk position", () => {
    const disk = [rec("general-purpose", "builtin"), rec("reviewer", "user", "disk")];
    const runtime = [rec("reviewer", "runtime", "runtime")];
    const merged = mergeAvailableWorkers(disk, runtime);
    assert.deepEqual(merged.map((r) => r.name), ["general-purpose", "reviewer"]);
    const reviewer = merged.find((r) => r.name === "reviewer")!;
    assert.equal(reviewer.source, "runtime");
    assert.equal(reviewer.whenToUse, "runtime");
  });

  it("mixes overlaid and runtime-only: disk positions held, new names appended", () => {
    const disk = [rec("git", "builtin"), rec("reviewer", "user")];
    const runtime = [rec("reviewer", "runtime"), rec("custom", "runtime")];
    assert.deepEqual(
      mergeAvailableWorkers(disk, runtime).map((r) => r.name),
      ["git", "reviewer", "custom"],
    );
  });

  it("dedups within disk by name, last position-stable wins (project shadows user)", () => {
    const disk = [rec("dup", "user", "user"), rec("dup", "project", "project")];
    const merged = mergeAvailableWorkers(disk, []);
    assert.deepEqual(merged.map((r) => r.name), ["dup"]);
    assert.equal(merged[0].source, "project");
    assert.equal(merged[0].whenToUse, "project");
  });
});
