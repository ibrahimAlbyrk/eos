import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { PromptTemplateService } from "../PromptTemplateService.ts";
import { resolveWorkerAction } from "../worker-actions.ts";

const promptsDir = join(import.meta.dirname, "..", "..", "prompts");

describe("PromptTemplateService", () => {
  const svc = new PromptTemplateService(promptsDir);

  it("strips frontmatter and substitutes positional args", () => {
    const out = svc.render("commit.md", ["true"]);
    assert.ok(out.length > 0);
    assert.ok(!out.startsWith("---"), "frontmatter not stripped");
    assert.ok(!out.includes("$1"), "unsubstituted $1");
    assert.ok(out.includes("PUSH_TO_REMOTE: true"));
  });

  it("leaves $N intact when no args are given", () => {
    const out = svc.render("rebase.md");
    assert.ok(out.includes("TARGET_BRANCH: $1"));
  });
});

describe("worker actions", () => {
  const svc = new PromptTemplateService(promptsDir);

  it("resolves every action with substituted variables and a command-like display", () => {
    for (const action of ["commit", "commit-push", "pr", "draft-pr"] as const) {
      const { prompt, display } = resolveWorkerAction(svc, action);
      assert.ok(prompt.length > 0, `${action}: empty prompt`);
      assert.ok(!prompt.includes("$1"), `${action}: unsubstituted $1`);
      assert.ok(display.startsWith("/"), `${action}: display must look like a command`);
    }
  });

  it("commit variants share one template, differ only by PUSH_TO_REMOTE", () => {
    const commit = resolveWorkerAction(svc, "commit");
    const push = resolveWorkerAction(svc, "commit-push");
    assert.ok(commit.prompt.includes("PUSH_TO_REMOTE: false"));
    assert.ok(push.prompt.includes("PUSH_TO_REMOTE: true"));
    assert.equal(commit.display, "/commit");
    assert.equal(push.display, "/commit and push");
  });

  it("pr variants share one template, differ only by DRAFT", () => {
    const pr = resolveWorkerAction(svc, "pr");
    const draft = resolveWorkerAction(svc, "draft-pr");
    assert.ok(pr.prompt.includes("DRAFT: false"));
    assert.ok(draft.prompt.includes("DRAFT: true"));
    assert.equal(pr.display, "/create-pr");
    assert.equal(draft.display, "/create-pr draft");
  });
});
