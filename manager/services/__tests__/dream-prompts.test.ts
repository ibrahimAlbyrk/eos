import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { FilePromptSource } from "../../../infra/src/prompt/FilePromptSource.ts";
import { PromptRegistry } from "../../../core/src/services/PromptRegistry.ts";
import { PromptService } from "../../../core/src/services/PromptService.ts";
import { TOOL_NAME_VARS } from "../../prompt-tool-names.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLogger; } };

describe("dream prompts", () => {
  const registry = new PromptRegistry(new FilePromptSource([join(import.meta.dirname, "..", "..", "prompts")]), noopLogger);
  const prompts = new PromptService(registry, TOOL_NAME_VARS);

  it("all four render, with data fenced and nothing left unresolved", () => {
    const recall = prompts.render("dream/recall", { CHAT: "profile-design", PROJECT: "/eos", TRANSCRIPT: "[e1] USER: {{not a var}}" });
    assert.match(recall, /<transcript>\n\[e1\] USER: \{\{not a var\}\}\n<\/transcript>/);
    const consolidate = prompts.render("dream/consolidate", { OBSERVATIONS: "o1", MEMORIES: "um-1", PROFILE: "p", PROJECTS: "/eos" });
    assert.match(consolidate, /<observations>\no1\n<\/observations>/);
    for (const id of ["dream/recall-system", "dream/consolidate-system"]) {
      const text = prompts.render(id);
      assert.match(text, /ONE JSON object/);
      assert.doesNotMatch(text, /\{\{/);
    }
  });
});
