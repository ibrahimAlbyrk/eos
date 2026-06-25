import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderWorkflowDefinitionCatalog } from "../domain/workflow-definition-catalog.ts";
import { renderCapabilityCatalog } from "../domain/workflow-capability-catalog.ts";
import { assembleSystemPrompt } from "../use-cases/AssembleSystemPrompt.ts";
import { PromptRegistry } from "../services/PromptRegistry.ts";
import { PromptService } from "../services/PromptService.ts";
import type { Logger } from "../ports/Logger.ts";
import type { PromptSource } from "../ports/PromptSource.ts";
import type { RawPrompt } from "../domain/prompt.ts";
import type { SessionSpawnContext } from "../use-cases/AssembleSystemPrompt.ts";
import type { WorkflowDefinitionRecord } from "../../../contracts/src/workflow.ts";

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};
const src = (p: RawPrompt[]): PromptSource => ({ list: () => p });
const node = { type: "step", id: "x", prompt: "p" };
const rec = (r: Partial<WorkflowDefinitionRecord> & { name: string }): WorkflowDefinitionRecord =>
  ({ source: "builtin", root: node, ...r }) as WorkflowDefinitionRecord;

describe("renderWorkflowDefinitionCatalog", () => {
  it("one line per workflow: name + description, with an arg hint from argsSchema", () => {
    const out = renderWorkflowDefinitionCatalog([
      rec({ name: "alpha", description: "First flow" }),
      rec({ name: "beta", description: "Second", argsSchema: { type: "object", properties: { topic: {}, depth: {} } } }),
      rec({ name: "gamma", argsSchema: { type: "object" } }),
    ]);
    assert.deepEqual(out.split("\n"), [
      "- alpha: First flow",
      "- beta: Second (args: topic, depth)",
      "- gamma (takes args)",
    ]);
  });

  it("dedups by name last-wins while keeping first-seen position (overlay precedence)", () => {
    const out = renderWorkflowDefinitionCatalog([
      rec({ name: "alpha", description: "builtin A", source: "builtin" }),
      rec({ name: "beta", description: "builtin B", source: "builtin" }),
      rec({ name: "alpha", description: "runtime A", source: "runtime" }),
    ]);
    assert.deepEqual(out.split("\n"), ["- alpha: runtime A", "- beta: builtin B"]);
  });
});

describe("renderCapabilityCatalog", () => {
  it("renders node-type names + transform-fn names as two labeled lines", () => {
    assert.equal(
      renderCapabilityCatalog(["step", "script", "sequence"], ["identity", "dedup"]),
      "Node types: step, script, sequence\nTransform fns: identity, dedup",
    );
  });
});

describe("workflow catalog vars flow through AssembleSystemPrompt", () => {
  const fragments: RawPrompt[] = [
    { id: "core/identity", body: "Eos.", frontmatter: { dpi: { layer: "core", priority: 0 } } },
    {
      id: "role/orchestrator/wf",
      body: "LIST:\n{{AVAILABLE_WORKFLOWS_CATALOG}}\nVOCAB:\n{{WORKFLOW_CAPABILITY_CATALOG}}",
      frontmatter: {
        variables: ["AVAILABLE_WORKFLOWS_CATALOG", "WORKFLOW_CAPABILITY_CATALOG"],
        dpi: { layer: "role", priority: 10, when: { fact: "role", eq: "orchestrator" } },
      },
    },
  ];
  const build = () => {
    const registry = new PromptRegistry(src(fragments), noopLogger);
    return { registry, prompts: new PromptService(registry) };
  };
  const baseCtx: SessionSpawnContext = {
    role: "worker", parentId: null, name: "t", workerId: null, model: "opus", effort: null,
    permissionMode: "acceptEdits", cwd: "/x", worktreeDir: null, branch: null, repoRoot: null,
    isAttached: false, hasMcp: false, canCollaborate: false, workerDefinition: "", workerDefinitionCatalog: "",
    workflowDefinitionCatalog: "- demo: a demo flow",
    workflowCapabilityCatalog: "Node types: step, script\nTransform fns: identity",
  };

  it("orchestrator → both catalogs interpolated into the role fragment", () => {
    const r = assembleSystemPrompt(build(), { ...baseCtx, role: "orchestrator" });
    assert.ok(r.text.includes("LIST:\n- demo: a demo flow"));
    assert.ok(r.text.includes("VOCAB:\nNode types: step, script\nTransform fns: identity"));
  });

  it("worker → role fragment is gated out, so neither catalog appears", () => {
    const r = assembleSystemPrompt(build(), { ...baseCtx, role: "worker" });
    assert.ok(!r.text.includes("- demo: a demo flow"));
    assert.ok(!r.text.includes("Node types: step, script"));
  });
});
