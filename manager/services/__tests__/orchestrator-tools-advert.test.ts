import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { PromptService } from "../../../core/src/services/PromptService.ts";
import { PromptRegistry } from "../../../core/src/services/PromptRegistry.ts";
import { FilePromptSource } from "../../../infra/src/prompt/FilePromptSource.ts";
import { TOOL_NAME_VARS } from "../../prompt-tool-names.ts";

const noopLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLog; } };
const promptsDir = join(import.meta.dirname, "..", "..", "prompts");
const prompts = new PromptService(new PromptRegistry(new FilePromptSource([promptsDir]), noopLog as never), TOOL_NAME_VARS);

// The loop system is TEMPORARILY disabled: dynamic_loop is not registered and the
// tool overview no longer advertises it. The tool def + TOOL_NAME_VARS mapping are
// kept intact so re-enabling is a revert. See manager/tools/registry.ts.
describe("orchestrator tool overview — dynamic_loop is not advertised (loop system disabled)", () => {
  it("DYNAMIC_LOOP_TOOL still resolves to the real tool name (def kept for reversibility)", () => {
    assert.equal(TOOL_NAME_VARS.DYNAMIC_LOOP_TOOL, "dynamic_loop");
  });

  it("the rendered tool overview no longer advertises the goal-gate loop", () => {
    const out = prompts.render("role/orchestrator/02-your-tools");
    assert.doesNotMatch(out, /dynamic_loop/);
    assert.doesNotMatch(out, /goal gate/i);
  });
});
