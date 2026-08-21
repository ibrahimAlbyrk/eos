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

describe("classifyTool browser verbs", () => {
  it("classifies the read verbs as browserRead on both control servers", () => {
    for (const verb of ["snapshot", "find", "get", "screenshot", "tabs"]) {
      assert.equal(classifyTool(`mcp__worker__browser_${verb}`), "browserRead", verb);
      assert.equal(classifyTool(`mcp__orchestrator__browser_${verb}`), "browserRead", verb);
    }
  });

  it("classifies the acting verbs as browserWrite", () => {
    const verbs = ["navigate", "act", "type", "fill_form", "press", "scroll", "eval", "new_tab", "close_tab", "mute"];
    for (const verb of verbs) {
      assert.equal(classifyTool(`mcp__worker__browser_${verb}`), "browserWrite", verb);
    }
  });

  it("treats an unlisted verb as a write (fail closed)", () => {
    assert.equal(classifyTool("mcp__worker__browser_wait"), "browserWrite");
    assert.equal(classifyTool("mcp__worker__browser_something_new"), "browserWrite");
  });

  it("leaves every other mcp tool in the mcp category", () => {
    assert.equal(classifyTool("mcp__worker__send_message_to_parent"), "mcp");
    assert.equal(classifyTool("mcp__context7__query-docs"), "mcp");
    // Only the Eos control servers host browser verbs — a lookalike on a user
    // MCP server is an ordinary mcp tool.
    assert.equal(classifyTool("mcp__github__browser_navigate"), "mcp");
  });
});

describe("MODE_SPECS verdict table", () => {
  it("exposes exactly the two supported modes", () => {
    assert.deepEqual(Object.keys(MODE_SPECS).sort(), ["acceptEdits", "bypassPermissions"]);
  });

  it("acceptEdits allows reads/mcp/planFile/fileEdit, asks for the rest", () => {
    const m = MODE_SPECS.acceptEdits;
    assert.equal(m.decide("planFile"), "allow");
    assert.equal(m.decide("fileEdit"), "allow");
    assert.equal(m.decide("shell"), "ask");
    assert.equal(m.decide("network"), "ask");
    assert.equal(m.decide("other"), "ask");
  });

  it("acceptEdits allows browserRead but asks before anything drives the page", () => {
    const m = MODE_SPECS.acceptEdits;
    assert.equal(m.decide("browserRead"), "allow");
    assert.equal(m.decide("browserWrite"), "ask");
  });

  it("bypassPermissions allows everything", () => {
    const m = MODE_SPECS.bypassPermissions;
    for (const cat of ["fileEdit", "planFile", "shell", "read", "mcp", "network", "other", "browserRead", "browserWrite"] as const) {
      assert.equal(m.decide(cat), "allow", cat);
    }
  });

  it("every mode allows planFile", () => {
    for (const spec of Object.values(MODE_SPECS)) {
      assert.equal(spec.decide("planFile"), "allow", spec.mode);
    }
  });
});
