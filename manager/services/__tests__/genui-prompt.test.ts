// Visual answers in the prompts: the orchestrator and focused fragments (gated on
// the user's genui.level), never a worker; present's description carries the
// catalog generated from the validator's schemas.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { FilePromptSource } from "../../../infra/src/prompt/FilePromptSource.ts";
import { PromptRegistry } from "../../../core/src/services/PromptRegistry.ts";
import { PromptService } from "../../../core/src/services/PromptService.ts";
import { assembleSystemPrompt, type SessionSpawnContext } from "../../../core/src/use-cases/AssembleSystemPrompt.ts";
import { renderGenuiLevel } from "../../../core/src/services/render-genui-level.ts";
import { catalogPrompt } from "../../../contracts/src/genui/prompt.ts";
import { TOOL_NAME_VARS } from "../../prompt-tool-names.ts";
import { renderToolDescriptions } from "../../tool-descriptions.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLogger; } };
const promptsDir = join(import.meta.dirname, "..", "..", "prompts");

function assemble(ctx: Partial<SessionSpawnContext>): { text: string; ids: string[] } {
  const registry = new PromptRegistry(new FilePromptSource([promptsDir]), noopLogger);
  const base: SessionSpawnContext = {
    role: "worker", parentId: null, name: "demo", workerId: "w-1", model: "sonnet", effort: null,
    permissionMode: "bypassPermissions", cwd: "/repo", worktreeDir: null, branch: null, repoRoot: null,
    isAttached: false, hasMcp: false, canCollaborate: false, workerDefinition: "", workerDefinitionCatalog: "",
  };
  const r = assembleSystemPrompt({ registry, prompts: new PromptService(registry, TOOL_NAME_VARS) }, { ...base, ...ctx });
  return { text: r.text, ids: r.activeFragmentIds };
}

describe("visual answers in the system prompt", () => {
  for (const role of ["orchestrator", "focused"] as const) {
    it(`${role}: teaches present at the user's level, with every tool name resolved`, () => {
      const { text } = assemble({ role, ...(role === "focused" ? { userProfile: "" } : {}) });
      assert.match(text, /## Visual answers/);
      assert.ok(text.includes(renderGenuiLevel("balanced")), "no setting → balanced");
      for (const v of ["PRESENT_TOOL", "PRESENT_APP_TOOL", "FIND_PLACES_TOOL", "CURRENT_LOCATION_TOOL"] as const) {
        assert.ok(text.includes(String(TOOL_NAME_VARS[v])), v);
      }
      assert.match(text, /Never invent/);
      assert.match(text, /\[view action\] <label>/);
      assert.doesNotMatch(text, /\{\{[A-Z]/);
    });

    it(`${role}: "text" keeps only the off line; "rich" says so`, () => {
      const off = assemble({ role, genuiLevel: "text", userProfile: "" }).text;
      assert.ok(off.includes(renderGenuiLevel("text")));
      assert.doesNotMatch(off, /Never invent|<Map of=/);
      const rich = assemble({ role, genuiLevel: "rich", userProfile: "" }).text;
      assert.ok(rich.includes(renderGenuiLevel("rich")));
      assert.match(rich, /Never invent/);
    });
  }

  it("a worker never hears about visual answers", () => {
    for (const parentId of [null, "orch-1"]) {
      const { text, ids } = assemble({ role: "worker", parentId });
      assert.ok(!ids.some((id) => id.endsWith("present")), ids.join(","));
      assert.doesNotMatch(text, /Visual answers|present_app|find_places|current_location/);
    }
  });

  it("an unknown level reads as balanced", () => {
    assert.equal(renderGenuiLevel("loud"), renderGenuiLevel("balanced"));
    assert.equal(renderGenuiLevel(undefined), renderGenuiLevel("balanced"));
  });
});

describe("visual-answer tool descriptions", () => {
  it("present carries the generated catalog verbatim", () => {
    const d = renderToolDescriptions(promptsDir, ["present"]);
    assert.ok(d.present.includes(catalogPrompt()));
    assert.match(d.present, /a `send` action posts the user's click back to you/i);
  });

  it("present_app, find_places and current_location render with their tool names resolved", () => {
    const d = renderToolDescriptions(promptsDir, ["present_app", "find_places", "current_location"]);
    assert.match(d.present_app, /sandbox/);
    assert.match(d.find_places, /OpenStreetMap/);
    assert.match(d.current_location, /find_places/);
    for (const text of Object.values(d)) {
      assert.doesNotMatch(text, /\{\{/);
      assert.notEqual(text, "present_app");
    }
  });
});
