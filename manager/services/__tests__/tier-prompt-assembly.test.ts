import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { FilePromptSource } from "../../../infra/src/prompt/FilePromptSource.ts";
import { PromptRegistry } from "../../../core/src/services/PromptRegistry.ts";
import { PromptService } from "../../../core/src/services/PromptService.ts";
import { assembleSystemPrompt } from "../../../core/src/use-cases/AssembleSystemPrompt.ts";
import { TOOL_NAME_VARS } from "../../prompt-tool-names.ts";
import { CLAUDE_IDENTITY, defaultTierName } from "../../../core/src/domain/model-tier.ts";
import { renderModelTierTable, renderEffortSection, defaultEffortFor } from "../../shared/tier-prompt-render.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";
import type { SessionSpawnContext } from "../../../core/src/use-cases/AssembleSystemPrompt.ts";

const noopLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return noopLogger; },
};

const promptsDir = join(import.meta.dirname, "..", "..", "prompts");

function deps() {
  const registry = new PromptRegistry(new FilePromptSource([promptsDir]), noopLogger);
  return { registry, prompts: new PromptService(registry, TOOL_NAME_VARS) };
}

// The identity vars the composition root computes per-spawn (container.ts). On the
// Claude lane these must render byte-identically to the pre-tier prompts.
const claudeIdentityVars = {
  personaName: CLAUDE_IDENTITY.persona,
  modelTierTable: renderModelTierTable(CLAUDE_IDENTITY),
  defaultTier: defaultTierName(CLAUDE_IDENTITY),
  effortSection: renderEffortSection(CLAUDE_IDENTITY),
  defaultEffort: defaultEffortFor(CLAUDE_IDENTITY),
  effortSupported: CLAUDE_IDENTITY.effortSupported,
};

const baseCtx: SessionSpawnContext = {
  role: "worker",
  parentId: "orch",
  name: "demo",
  workerId: "w-1",
  model: "opus",
  effort: null,
  permissionMode: "bypassPermissions",
  cwd: "/repo",
  worktreeDir: null,
  branch: null,
  repoRoot: null,
  isAttached: false,
  hasMcp: false,
  canCollaborate: false,
  workerDefinition: "",
  workerDefinitionCatalog: "",
  ...claudeIdentityVars,
};

describe("Claude-lane tier/persona vocabulary renders byte-equivalent", () => {
  it("worker prompt still reads 'background Claude worker' when PERSONA_NAME is Claude", async () => {
    const r = await assembleSystemPrompt(deps(), baseCtx);
    assert.match(r.text, /background Claude worker/); // persona byte-equivalence
    assert.match(r.text, /another Claude/);           // the second persona slot in 01-intro
    assert.doesNotMatch(r.text, /\{\{/);              // no unresolved variables leak
  });

  it("orchestrator §Model renders Claude's 4-tier table with high marked default (not the stronger max)", async () => {
    const r = await assembleSystemPrompt(deps(), { ...baseCtx, role: "orchestrator", parentId: null });
    assert.match(r.text, /\| max \| fable \|/); // strongest tier, not the default
    assert.match(r.text, /\| high \(default\) \| opus \|/); // default stays high=opus, decoupled from tiers[0]
    assert.match(r.text, /\| medium \| sonnet \|/);
    assert.match(r.text, /\| low \| haiku \|/);
    // The effort table (Claude supports the lever) and the tier-vocabulary default —
    // {{DEFAULT_TIER}} resolves to "high" (opus), NOT the strongest "max".
    assert.match(r.text, /xhigh \(default\)/);
    assert.match(r.text, /the \*\*high\*\* tier at \*\*xhigh\*\* effort/);
    // No unresolved {{UPPER_SNAKE}} var (the §Workflows fragment keeps literal
    // lowercase {{nodes.*}} binding examples on purpose, so guard the var shape).
    assert.doesNotMatch(r.text, /\{\{[A-Z]/);
  });

  it("orchestrator §Available workers example uses tier vocabulary, not a Claude alias", async () => {
    const r = await assembleSystemPrompt(deps(), { ...baseCtx, role: "orchestrator", parentId: null });
    assert.match(r.text, /model: "high", effort: "high"/); // EFFORT_SUPPORTED gate open on Claude
    assert.doesNotMatch(r.text, /model: "opus"/);
  });
});
