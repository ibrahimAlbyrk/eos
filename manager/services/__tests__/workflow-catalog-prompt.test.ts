import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { FilePromptSource } from "../../../infra/src/prompt/FilePromptSource.ts";
import { PromptRegistry } from "../../../core/src/services/PromptRegistry.ts";
import { PromptService } from "../../../core/src/services/PromptService.ts";
import { assembleSystemPrompt } from "../../../core/src/use-cases/AssembleSystemPrompt.ts";
import { InMemoryStepExecutorRegistry } from "../../../core/src/workflow/registry.ts";
import { registerBuiltinExecutors } from "../../../core/src/workflow/register-builtins.ts";
import { renderCapabilityCatalog } from "../../../core/src/domain/workflow-capability-catalog.ts";
import { renderWorkflowDefinitionCatalog } from "../../../core/src/domain/workflow-definition-catalog.ts";
import { BuiltinWorkflowDefinitionSource } from "../../workflows/index.ts";
import { TOOL_NAME_VARS } from "../../prompt-tool-names.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";
import type { SessionSpawnContext } from "../../../core/src/use-cases/AssembleSystemPrompt.ts";

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};

const promptsDir = join(import.meta.dirname, "..", "..", "prompts");
const deps = () => {
  const registry = new PromptRegistry(new FilePromptSource([promptsDir]), noopLogger);
  return { registry, prompts: new PromptService(registry, TOOL_NAME_VARS) };
};

// The real registry-derived catalogs the container injects, built here the same
// way (so the test fails if an executor/fn stops being registered, or the prompt
// stops injecting them).
const workflowRegistry = new InMemoryStepExecutorRegistry();
const { transforms } = registerBuiltinExecutors(workflowRegistry);
const capability = renderCapabilityCatalog(workflowRegistry.types(), transforms.names());
const list = renderWorkflowDefinitionCatalog(new BuiltinWorkflowDefinitionSource().list());

const baseCtx: SessionSpawnContext = {
  role: "worker", parentId: "orch", name: "demo", workerId: "w-1", model: "sonnet", effort: null,
  permissionMode: "bypassPermissions", cwd: "/repo", worktreeDir: null, branch: null, repoRoot: null,
  isAttached: false, hasMcp: false, canCollaborate: false, workerDefinition: "", workerDefinitionCatalog: "",
  workflowDefinitionCatalog: list, workflowCapabilityCatalog: capability,
};

describe("orchestrator workflow catalogs (WU-5 list + WU-6 capability)", () => {
  it("orchestrator prompt carries the dynamic workflow LIST and the registry-derived capability VOCABULARY", () => {
    const r = assembleSystemPrompt(deps(), { ...baseCtx, role: "orchestrator", parentId: null });
    // WU-5: the dynamic list fragment + its rendered builtin catalog.
    assert.ok(r.activeFragmentIds.includes("role/orchestrator/18-available-workflows"));
    assert.match(r.text, /# Available workflows/);
    assert.ok(r.text.includes("research-analysis-planning"));
    assert.ok(r.text.includes(list));
    // WU-6: the capability roster is registry-derived (so `script` from WU-1 rides
    // along automatically) and injected verbatim into §Workflows.
    assert.ok(capability.includes("script"));
    assert.ok(r.text.includes(capability));
    assert.ok(transforms.names().every((fn) => r.text.includes(fn)));
    assert.doesNotMatch(r.text, /\{\{[A-Z]/); // both new vars resolved, none left literal
  });

  it("a plain worker and a collaborate subagent carry NEITHER catalog", () => {
    const worker = assembleSystemPrompt(deps(), { ...baseCtx, role: "worker" });
    assert.ok(!worker.activeFragmentIds.includes("role/orchestrator/18-available-workflows"));
    assert.ok(!worker.activeFragmentIds.includes("role/orchestrator/17-workflows"));
    assert.doesNotMatch(worker.text, /# Available workflows/);
    assert.ok(!worker.text.includes(list));
    assert.ok(!worker.text.includes(capability));

    const sub = assembleSystemPrompt(deps(), { ...baseCtx, role: "worker", canCollaborate: true });
    assert.ok(!sub.activeFragmentIds.includes("role/orchestrator/18-available-workflows"));
    assert.ok(!sub.text.includes(capability));
  });
});
