import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyTool, isPathInside, MODE_SPECS } from "../domain/permission-mode.ts";

const PLANS = "/Users/me/.claude/plans";

describe("isPathInside", () => {
  it("accepts a strict child", () => {
    assert.equal(isPathInside(`${PLANS}/plan.md`, PLANS), true);
  });

  it("accepts nested children", () => {
    assert.equal(isPathInside(`${PLANS}/a/b/plan.md`, PLANS), true);
  });

  it("rejects the dir itself", () => {
    assert.equal(isPathInside(PLANS, PLANS), false);
  });

  it("rejects siblings and prefix lookalikes", () => {
    assert.equal(isPathInside("/Users/me/.claude/plans-evil/x.md", PLANS), false);
    assert.equal(isPathInside("/Users/me/.claude/other/x.md", PLANS), false);
  });

  it("resolves .. traversal out of the dir", () => {
    assert.equal(isPathInside(`${PLANS}/../../etc/passwd`, PLANS), false);
    assert.equal(isPathInside(`${PLANS}/sub/../plan.md`, PLANS), true);
  });

  it("rejects relative paths", () => {
    assert.equal(isPathInside("plans/plan.md", PLANS), false);
  });

  it("ignores '.' segments and trailing slashes", () => {
    assert.equal(isPathInside(`${PLANS}/./plan.md`, `${PLANS}/`), true);
  });
});

describe("classifyTool planFile", () => {
  it("classifies a Write into plansDir as planFile", () => {
    assert.equal(classifyTool("Write", { file_path: `${PLANS}/plan.md` }, PLANS), "planFile");
  });

  it("classifies Edit/NotebookEdit via their path fields", () => {
    assert.equal(classifyTool("Edit", { file_path: `${PLANS}/plan.md` }, PLANS), "planFile");
    assert.equal(classifyTool("NotebookEdit", { notebook_path: `${PLANS}/n.ipynb` }, PLANS), "planFile");
  });

  it("stays fileEdit outside plansDir", () => {
    assert.equal(classifyTool("Write", { file_path: "/repo/src/x.ts" }, PLANS), "fileEdit");
  });

  it("stays fileEdit on traversal escape", () => {
    assert.equal(classifyTool("Write", { file_path: `${PLANS}/../../etc/passwd` }, PLANS), "fileEdit");
  });

  it("stays fileEdit without plansDir or input", () => {
    assert.equal(classifyTool("Write", { file_path: `${PLANS}/plan.md` }), "fileEdit");
    assert.equal(classifyTool("Write", undefined, PLANS), "fileEdit");
  });

  it("does not affect non-fileEdit tools", () => {
    assert.equal(classifyTool("Bash", { file_path: `${PLANS}/plan.md` }, PLANS), "shell");
    assert.equal(classifyTool("Read", { file_path: `${PLANS}/plan.md` }, PLANS), "read");
  });
});

describe("MODE_SPECS planFile verdicts", () => {
  it("plan mode allows planFile but denies fileEdit", () => {
    assert.equal(MODE_SPECS.plan.decide("planFile"), "allow");
    assert.equal(MODE_SPECS.plan.decide("fileEdit"), "deny");
  });

  it("every mode allows planFile", () => {
    for (const spec of Object.values(MODE_SPECS)) {
      assert.equal(spec.decide("planFile"), "allow", spec.mode);
    }
  });
});
