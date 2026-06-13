import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { evaluateCondition } from "../services/condition-eval.ts";
import { PromptRegistry } from "../services/PromptRegistry.ts";
import { PromptService } from "../services/PromptService.ts";
import { assembleSystemPrompt } from "../use-cases/AssembleSystemPrompt.ts";
import type { Logger } from "../ports/Logger.ts";
import type { PromptSource } from "../ports/PromptSource.ts";
import type { FactProvider, SessionSpawnContext } from "../ports/FactProvider.ts";
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
      id: "env/git-status",
      body: "branch={{MODEL}}",
      frontmatter: { dpi: { layer: "environment", priority: 20, when: { fact: "isGitRepo", eq: true } } },
    },
    {
      id: "env/worktree",
      body: "isolated worktree",
      frontmatter: { dpi: { layer: "environment", priority: 30, when: { fact: "isWorktree", eq: true } } },
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
    permissionMode: "default",
    cwd: "/x",
    worktreeDir: null,
    branch: null,
    repoRoot: null,
    isAttached: false,
    hasMcp: false,
  };

  it("(a) non-git orchestrator → core + role/orchestrator only, zero git prose", async () => {
    const { registry, prompts } = build();
    const r = await assembleSystemPrompt(
      { factProviders: [], registry, prompts },
      { ...baseCtx, role: "orchestrator" },
    );
    assert.deepEqual(r.activeFragmentIds, ["core/identity", "role/orchestrator"]);
    assert.doesNotMatch(r.text, /branch=/);
    assert.equal(r.facts.isGitRepo, false);
  });

  it("(b) git worker → core, git-status, worktree, role/worker (provider sets git facts)", async () => {
    const { registry, prompts } = build();
    const gitFacts: FactProvider = { gather: () => ({ isGitRepo: true, isWorktree: true }) };
    const r = await assembleSystemPrompt(
      { factProviders: [gitFacts], registry, prompts },
      { ...baseCtx, role: "worker" },
    );
    assert.deepEqual(r.activeFragmentIds, ["core/identity", "env/git-status", "env/worktree", "role/worker"]);
    assert.match(r.text, /branch=opus/); // {{model}} interpolated from facts
  });

  it("(c) attached worker → worktree-shared overrides worktree", async () => {
    const { registry, prompts } = build();
    const facts: FactProvider = { gather: () => ({ isGitRepo: true, isWorktree: true, isAttached: true }) };
    const r = await assembleSystemPrompt(
      { factProviders: [facts], registry, prompts },
      { ...baseCtx, role: "worker", isAttached: true },
    );
    assert.ok(r.activeFragmentIds.includes("env/worktree-shared"));
    assert.ok(!r.activeFragmentIds.includes("env/worktree"));
  });
});
