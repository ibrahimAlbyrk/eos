import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { evaluateCondition } from "../services/condition-eval.ts";
import { PromptRegistry } from "../services/PromptRegistry.ts";
import { PromptService } from "../services/PromptService.ts";
import { assembleSystemPrompt } from "../use-cases/AssembleSystemPrompt.ts";
import { selectFragments } from "../services/fragment-select.ts";
import type { Logger } from "../ports/Logger.ts";
import type { PromptSource } from "../ports/PromptSource.ts";
import type { SessionSpawnContext } from "../use-cases/AssembleSystemPrompt.ts";
import type { RawPrompt } from "../domain/prompt.ts";

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

describe("evaluateCondition robustness", () => {
  it("matches eq: null and eq: false via own-property detection", () => {
    assert.equal(evaluateCondition({ fact: "x", eq: null }, { x: null }), true);
    assert.equal(evaluateCondition({ fact: "y", eq: false }, { y: false }), true);
  });
  it("vacuous all([]) = true, any([]) = false", () => {
    assert.equal(evaluateCondition({ all: [] }, {}), true);
    assert.equal(evaluateCondition({ any: [] }, {}), false);
  });
});

describe("selectFragments edge cases", () => {
  it("a fragment cannot override itself (no empty-prompt footgun)", () => {
    const reg = new PromptRegistry(
      src([{ id: "self", body: "S", frontmatter: { dpi: { layer: "core", priority: 0, overrides: ["self"] } } }]),
      noopLogger,
    );
    const out = selectFragments(reg.fragments(), { role: "worker" } as never);
    assert.equal(out.length, 1);
    assert.equal(out[0].prompt.id, "self");
  });
});

describe("evaluateCondition", () => {
  const f = { role: "worker", isGitRepo: true, model: "opus", effort: null };

  it("applies leaf operators", () => {
    assert.equal(evaluateCondition({ fact: "isGitRepo", eq: true }, f), true);
    assert.equal(evaluateCondition({ fact: "role", eq: "orchestrator" }, f), false);
    assert.equal(evaluateCondition({ fact: "model", in: ["opus", "sonnet"] }, f), true);
    assert.equal(evaluateCondition({ fact: "model", nin: ["haiku"] }, f), true);
    assert.equal(evaluateCondition({ fact: "effort", exists: false }, f), true); // null → absent
    assert.equal(evaluateCondition({ fact: "isGitRepo", truthy: true }, f), true);
    assert.equal(evaluateCondition({ fact: "isGitRepo" }, f), true); // bare → truthy
  });

  it("composes all/any/not", () => {
    assert.equal(
      evaluateCondition({ all: [{ fact: "isGitRepo", eq: true }, { fact: "role", eq: "worker" }] }, f),
      true,
    );
    assert.equal(
      evaluateCondition({ any: [{ fact: "role", eq: "x" }, { fact: "role", eq: "worker" }] }, f),
      true,
    );
    assert.equal(evaluateCondition({ not: { fact: "isGitRepo", eq: true } }, f), false);
  });
});

describe("assembleSystemPrompt (§8 worked examples)", () => {
  const fragments: RawPrompt[] = [
    { id: "core/identity", body: "You are Eos.", frontmatter: { dpi: { layer: "core", priority: 0 } } },
    {
      id: "env/worktree",
      body: "worktree {{MODEL}}",
      frontmatter: { variables: ["MODEL"], dpi: { layer: "environment", priority: 30, when: { fact: "isWorktree", eq: true } } },
    },
    {
      id: "env/worktree-shared",
      body: "shared worktree",
      frontmatter: {
        dpi: { layer: "environment", priority: 30, when: { fact: "isAttached", eq: true }, overrides: ["env/worktree"] },
      },
    },
    {
      id: "role/orchestrator",
      body: "You coordinate.",
      frontmatter: { dpi: { layer: "role", priority: 10, when: { fact: "role", eq: "orchestrator" } } },
    },
    {
      id: "role/worker",
      body: "You execute.",
      frontmatter: { dpi: { layer: "role", priority: 10, when: { fact: "role", eq: "worker" } } },
    },
  ];

  function build() {
    const registry = new PromptRegistry(src(fragments), noopLogger);
    const prompts = new PromptService(registry);
    return { registry, prompts };
  }

  const baseCtx: SessionSpawnContext = {
    role: "worker",
    parentId: null,
    name: "test",
    workerId: null,
    model: "opus",
    effort: null,
    permissionMode: "acceptEdits",
    cwd: "/x",
    worktreeDir: null,
    branch: null,
    repoRoot: null,
    isAttached: false,
    hasMcp: false,
    canCollaborate: false,
  };

  it("(a) non-worktree orchestrator → core + role/orchestrator only", () => {
    const r = assembleSystemPrompt(build(), { ...baseCtx, role: "orchestrator" });
    assert.deepEqual(r.activeFragmentIds, ["core/identity", "role/orchestrator"]);
  });

  it("(b) worker in a worktree → core, env/worktree, role/worker; session var interpolated", () => {
    const r = assembleSystemPrompt(build(), { ...baseCtx, role: "worker", worktreeDir: "/wt" });
    assert.deepEqual(r.activeFragmentIds, ["core/identity", "env/worktree", "role/worker"]);
    assert.match(r.text, /worktree opus/); // {{MODEL}} from sessionVars(ctx)
  });

  it("(c) attached worker → worktree-shared overrides worktree", () => {
    const r = assembleSystemPrompt(build(), { ...baseCtx, role: "worker", worktreeDir: "/wt", isAttached: true });
    assert.ok(r.activeFragmentIds.includes("env/worktree-shared"));
    assert.ok(!r.activeFragmentIds.includes("env/worktree"));
  });
});
