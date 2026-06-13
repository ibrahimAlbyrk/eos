import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { FilePromptSource } from "../../../infra/src/prompt/FilePromptSource.ts";
import { PromptRegistry } from "../../../core/src/services/PromptRegistry.ts";
import { PromptService } from "../../../core/src/services/PromptService.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";
import { resolveWorkerAction } from "../worker-actions.ts";

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};

// The real built-in prompt library (manager/prompts), exercised end-to-end so
// the golden expectations track the actual shipped templates.
const promptsDir = join(import.meta.dirname, "..", "..", "prompts");
const prompts = new PromptService(new PromptRegistry(new FilePromptSource([promptsDir]), noopLogger));

describe("resolveWorkerAction (action templates via Layer 1)", () => {
  it("renders the commit prompt with PUSH_TO_REMOTE substituted", async () => {
    const off = await resolveWorkerAction(prompts, "commit");
    assert.equal(off.display, "/commit");
    assert.match(off.prompt, /PUSH_TO_REMOTE: false/);

    const on = await resolveWorkerAction(prompts, "commit-push");
    assert.equal(on.display, "/commit and push");
    assert.match(on.prompt, /PUSH_TO_REMOTE: true/);
  });

  it("renders the create-pr prompt with DRAFT substituted", async () => {
    const pr = await resolveWorkerAction(prompts, "pr");
    assert.match(pr.prompt, /DRAFT: false/);
    const draft = await resolveWorkerAction(prompts, "draft-pr");
    assert.equal(draft.display, "/create-pr draft");
    assert.match(draft.prompt, /DRAFT: true/);
  });

  it("renders the verify prompt verbatim", async () => {
    const v = await resolveWorkerAction(prompts, "verify");
    assert.match(v.prompt, /verify: <command>/);
    assert.match(v.prompt, /^# Purpose/); // frontmatter stripped + trimmed
  });

  it("leaves no unresolved placeholders and no frontmatter for any action", async () => {
    for (const action of ["commit", "commit-push", "pr", "draft-pr", "verify"] as const) {
      const { prompt } = await resolveWorkerAction(prompts, action);
      assert.doesNotMatch(prompt, /\{\{/, `${action} has an unresolved {{var}}`);
      assert.doesNotMatch(prompt, /^---/, `${action} leaked frontmatter`);
    }
  });
});
