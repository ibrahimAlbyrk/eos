import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { FilePromptSource } from "../../../infra/src/prompt/FilePromptSource.ts";
import { PromptRegistry } from "../../../core/src/services/PromptRegistry.ts";
import { PromptService } from "../../../core/src/services/PromptService.ts";
import { assembleSystemPrompt, type SessionSpawnContext } from "../../../core/src/use-cases/AssembleSystemPrompt.ts";
import { DEFAULT_USER_PREFERENCES } from "../../../core/src/services/render-user-profile.ts";
import { TOOL_NAME_VARS } from "../../prompt-tool-names.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLogger; } };
const promptsDir = join(import.meta.dirname, "..", "..", "prompts");

function assemble(ctx: Partial<SessionSpawnContext>): string {
  const registry = new PromptRegistry(new FilePromptSource([promptsDir]), noopLogger);
  const base: SessionSpawnContext = {
    role: "worker", parentId: null, name: "demo", workerId: "w-1", model: "sonnet", effort: null,
    permissionMode: "bypassPermissions", cwd: "/repo", worktreeDir: null, branch: null, repoRoot: null,
    isAttached: false, hasMcp: false, canCollaborate: false, workerDefinition: "", workerDefinitionCatalog: "",
  };
  return assembleSystemPrompt({ registry, prompts: new PromptService(registry, TOOL_NAME_VARS) }, { ...base, ...ctx }).text;
}

describe("USER_PROFILE in the preambles", () => {
  for (const role of ["worker", "orchestrator"] as const) {
    it(`${role}: no profile → the stock preferences, exactly once`, () => {
      const text = assemble({ role });
      assert.equal(text.split(DEFAULT_USER_PREFERENCES).length, 2);
    });

    it(`${role}: a profile block replaces them, verbatim`, () => {
      const block = "`<user_profile>`\n\n- Address the user as \"Ibrahim\".\n\n`</user_profile>`";
      const text = assemble({ role, userProfile: block });
      assert.ok(text.includes(block));
      assert.doesNotMatch(text, /user_preferences/);
    });
  }

  it("focused: the profile block and the memory tools, once", () => {
    const block = "`<user_profile>`\n\n- Address the user as \"Ibrahim\".\n\n`</user_profile>`";
    const text = assemble({ role: "focused", userProfile: block });
    assert.equal(text.split(block).length, 2);
    assert.match(text, /## The user's memory/);
    assert.ok(text.includes(TOOL_NAME_VARS.SEARCH_MEMORY_TOOL));
    assert.ok(text.includes(TOOL_NAME_VARS.SUGGEST_MEMORY_TOOL));
  });

  it("focused: an empty profile adds only the memory section", () => {
    const text = assemble({ role: "focused", userProfile: "" });
    assert.doesNotMatch(text, /user_preferences|user_profile>/);
    assert.match(text, /## The user's memory/);
  });

  it("focused: tells the agent how to send files to the user's other Macs — no other role hears it", () => {
    const text = assemble({ role: "focused", userProfile: "" });
    assert.match(text, /## The user's other Macs/);
    assert.ok(text.includes(TOOL_NAME_VARS.SEND_TO_MACHINE_TOOL));
    for (const role of ["worker", "orchestrator"] as const) assert.doesNotMatch(assemble({ role }), /send_to_machine|other Macs/);
  });

  it("profile text is never re-parsed as a template", () => {
    const text = assemble({ userProfile: "keep {{AGENT_NAME}} literal" });
    assert.ok(text.includes("keep {{AGENT_NAME}} literal"));
  });
});
