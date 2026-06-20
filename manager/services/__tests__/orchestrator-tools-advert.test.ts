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

describe("orchestrator tool overview — dynamic_loop advertisement", () => {
  it("DYNAMIC_LOOP_TOOL resolves to the real tool name", () => {
    assert.equal(TOOL_NAME_VARS.DYNAMIC_LOOP_TOOL, "dynamic_loop");
  });

  it("the rendered tool overview advertises dynamic_loop with goal-decomposition guidance", () => {
    const out = prompts.render("role/orchestrator/02-your-tools");
    assert.match(out, /dynamic_loop/);    // {{DYNAMIC_LOOP_TOOL}} interpolated, not a blank
    assert.match(out, /goal/i);
    assert.match(out, /criteria/i);       // decompose into checkable criteria
    assert.match(out, /verify/i);         // verify commands prevent reward-hacking
    assert.match(out, /command|judge|hybrid/); // strategy choice
  });
});
