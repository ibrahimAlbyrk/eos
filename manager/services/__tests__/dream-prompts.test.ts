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

  it("every step renders, with data fenced and nothing left unresolved", () => {
    const recall = prompts.render("dream/recall", { CHAT: "profile-design", PROJECT: "/eos", TRANSCRIPT: "[e1] USER: {{not a var}}" });
    assert.match(recall, /<transcript>\n\[e1\] USER: \{\{not a var\}\}\n<\/transcript>/);
    const match = prompts.render("dream/match", { SIGNALS: "s0", CANDIDATES: "dc-1", MEMORIES: "um-1" });
    assert.match(match, /<signals>\ns0\n<\/signals>[\s\S]*<candidates>\ndc-1\n<\/candidates>[\s\S]*<memories>\num-1\n<\/memories>/);
    const consolidate = prompts.render("dream/consolidate", { CANDIDATES: "dc-1", MEMORIES: "um-1", PROFILE: "p" });
    assert.match(consolidate, /<candidates>\ndc-1\n<\/candidates>[\s\S]*<profile>\np\n<\/profile>/);
    const critic = prompts.render("dream/critic", { PROPOSALS: "p0", MEMORIES: "um-1", PROFILE: "p" });
    assert.match(critic, /<proposals>\np0\n<\/proposals>/);
    for (const id of ["dream/recall-system", "dream/match-system", "dream/consolidate-system", "dream/critic-system"]) {
      const text = prompts.render(id);
      assert.match(text, /ONE call to the StructuredOutput tool/);
      assert.doesNotMatch(text, /\{\{/);
    }
  });
});
