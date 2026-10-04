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

  it("profile text is never re-parsed as a template", () => {
    const text = assemble({ userProfile: "keep {{AGENT_NAME}} literal" });
    assert.ok(text.includes("keep {{AGENT_NAME}} literal"));
  });
});
