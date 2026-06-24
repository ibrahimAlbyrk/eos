import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { FilePromptSource } from "../../../infra/src/prompt/FilePromptSource.ts";
import { PromptRegistry } from "../../../core/src/services/PromptRegistry.ts";
import { PromptService } from "../../../core/src/services/PromptService.ts";
import { assembleSystemPrompt } from "../../../core/src/use-cases/AssembleSystemPrompt.ts";
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

function deps() {
  const registry = new PromptRegistry(new FilePromptSource([promptsDir]), noopLogger);
  return { registry, prompts: new PromptService(registry, TOOL_NAME_VARS) };
}

const baseCtx: SessionSpawnContext = {
  role: "worker",
  parentId: "orch",
  name: "demo",
  workerId: "w-1",
  model: "sonnet",
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
};

// Verifies the DPI assembler selects + composes the right per-role system
// prompt for each spawn scenario. Each role is now a GROUP of concern fragments
// (role/<role>/NN-*) composed in priority order — the assembled text is
// byte-identical to the former monolith, just stored in pieces.
describe("DPI assembles per-role system prompts", () => {
  it("orchestrator → orchestrator preamble first, then only role/orchestrator/* fragments", async () => {
    const r = await assembleSystemPrompt(deps(), { ...baseCtx, role: "orchestrator", parentId: null });
    assert.ok(r.activeFragmentIds.length > 1); // split into concern fragments
    assert.equal(r.activeFragmentIds[0], "system-preamble-orchestrator"); // orchestrator preamble emits first
    assert.ok(!r.activeFragmentIds.includes("system-preamble-worker")); // worker preamble must NOT leak in
    assert.equal(r.activeFragmentIds[1], "role/orchestrator/01-intro"); // role intro is the first role fragment
    assert.ok(r.activeFragmentIds.slice(1).every((id) => id.startsWith("role/orchestrator/")));
    assert.match(r.text, /# Orchestrator/);
    // Tool-name variables resolve from the registry-backed globals.
    assert.match(r.text, /`spawn_worker`/);
    // No unresolved {{UPPER_SNAKE}} variable left. (The §Workflows fragment shows
    // literal lowercase {{nodes.*}}/{{args.*}} binding examples on purpose, so the
    // guard targets the unresolved-var shape, not every "{{".)
    assert.doesNotMatch(r.text, /\{\{[A-Z]/);
  });

  it("orchestrator → swarm playbook embedded in the system prompt (always-on)", async () => {
    const r = await assembleSystemPrompt(deps(), { ...baseCtx, role: "orchestrator", parentId: null });
    assert.ok(r.activeFragmentIds.includes("role/orchestrator/14-swarm-playbook"));
    assert.match(r.text, /# Swarm playbook/); // embedded, not referenced by path
    assert.match(r.text, /## Research swarms/); // research branch present
    assert.doesNotMatch(r.text, /\{\{[A-Z]/); // no unresolved {{UPPER_SNAKE}} tool var
  });

  it("orchestrator → workflows guidance embedded; absent from worker + subagent prompts", async () => {
    const orch = await assembleSystemPrompt(deps(), { ...baseCtx, role: "orchestrator", parentId: null });
    assert.ok(orch.activeFragmentIds.includes("role/orchestrator/17-workflows"));
    assert.match(orch.text, /# Workflows/);
    // The fan-out binding syntax renders LITERALLY (via the LB/RB escape), so the
    // orchestrator learns the exact tokens it must emit in a spec.
    assert.ok(orch.text.includes("{{nodes.<prefix>-*.output}}"));
    assert.ok(orch.text.includes("{{args.<field>}}"));
    assert.match(orch.text, /run-inline/); // the 5 modes are named
    // Orchestrator-only: a plain worker and a collaborate subagent must NOT carry it.
    const worker = await assembleSystemPrompt(deps(), { ...baseCtx, role: "worker" });
    assert.ok(!worker.activeFragmentIds.includes("role/orchestrator/17-workflows"));
    assert.doesNotMatch(worker.text, /# Workflows/);
    const sub = await assembleSystemPrompt(deps(), { ...baseCtx, role: "worker", canCollaborate: true });
    assert.ok(!sub.activeFragmentIds.includes("role/orchestrator/17-workflows"));
  });

  it("git agent → worker preamble first, then only role/git/* fragments", async () => {
    const r = await assembleSystemPrompt(deps(), { ...baseCtx, role: "git" });
    assert.equal(r.activeFragmentIds[0], "system-preamble-worker");
    assert.ok(!r.activeFragmentIds.includes("system-preamble-orchestrator"));
    assert.ok(r.activeFragmentIds.slice(1).every((id) => id.startsWith("role/git/")));
    assert.match(r.text, /# Git Agent/);
  });

  it("subagent worker (no worktree) → worker preamble first, then only role/worker/*, zero worktree prose", async () => {
    const r = await assembleSystemPrompt(deps(), { ...baseCtx, role: "worker" });
    assert.equal(r.activeFragmentIds[0], "system-preamble-worker");
    assert.ok(!r.activeFragmentIds.includes("system-preamble-orchestrator"));
    assert.ok(r.activeFragmentIds.slice(1).every((id) => id.startsWith("role/worker/")));
    assert.match(r.text, /# Worker/);
    // Worktree isolation content is gone for a plain-cwd worker (worker/04
    // removed; env/worktree* are worktree-gated).
    assert.doesNotMatch(r.text, /isolated git worktree|Workspace isolation/);
  });

  it("worker in a worktree → role fragments THEN env block, vars substituted", async () => {
    const r = await assembleSystemPrompt(deps(), {
      ...baseCtx,
      role: "worker",
      worktreeDir: "/repo/.eos/wt/x",
      branch: "eos-x",
      repoRoot: "/repo",
    });
    // worker preamble (layer core) first, env/worktree (layer custom) last.
    assert.equal(r.activeFragmentIds[0], "system-preamble-worker");
    assert.ok(!r.activeFragmentIds.includes("system-preamble-orchestrator"));
    assert.equal(r.activeFragmentIds.at(-1), "env/worktree");
    assert.ok(r.activeFragmentIds.slice(1, -1).every((id) => id.startsWith("role/worker/")));
    assert.match(r.text, /# Worker/); // role content present
    assert.match(r.text, /isolation: worktree/); // env block follows
    assert.match(r.text, /branch `eos-x`/); // BRANCH substituted
    assert.match(r.text, /agent: demo \(w-1\)/); // AGENT_NAME + WORKER_ID
    assert.doesNotMatch(r.text, /\{\{/); // no unresolved variables
  });

  it("attached worker → worktree-shared overrides the isolated block", async () => {
    const r = await assembleSystemPrompt(deps(), {
      ...baseCtx,
      role: "worker",
      worktreeDir: "/repo/.eos/wt/x",
      branch: "eos-x",
      repoRoot: "/repo",
      isAttached: true,
    });
    assert.ok(r.activeFragmentIds.includes("env/worktree-shared"));
    assert.ok(!r.activeFragmentIds.includes("env/worktree"));
    assert.match(r.text, /shared worktree \(attached\)/);
  });

  it("exactly ONE role-specific preamble emits FIRST for every role — never both, never neither", async () => {
    const ORCH = "system-preamble-orchestrator";
    const WORKER = "system-preamble-worker";
    const scenarios: Array<{ label: string; ctx: SessionSpawnContext; id: string }> = [
      { label: "orchestrator", ctx: { ...baseCtx, role: "orchestrator", parentId: null }, id: ORCH },
      { label: "worker (subagent)", ctx: { ...baseCtx, role: "worker" }, id: WORKER },
      { label: "git", ctx: { ...baseCtx, role: "git" }, id: WORKER },
      {
        label: "worktree worker",
        ctx: { ...baseCtx, role: "worker", worktreeDir: "/repo/.eos/wt/x", branch: "eos-x", repoRoot: "/repo" },
        id: WORKER,
      },
    ];
    for (const { label, ctx, id } of scenarios) {
      const r = await assembleSystemPrompt(deps(), ctx);
      // Exactly one preamble, and it is first — proves the two `when` gates are exact complements.
      const preambles = r.activeFragmentIds.filter((x) => x === ORCH || x === WORKER);
      assert.deepEqual(preambles, [id], `${label}: must carry exactly one preamble (${id})`);
      assert.equal(r.activeFragmentIds[0], id, `${label}: preamble must sort first`);
    }
  });

  it("collaborate worker → peer-collaboration fragment present; off → absent", async () => {
    const off = await assembleSystemPrompt(deps(), { ...baseCtx, role: "worker" });
    assert.ok(!off.activeFragmentIds.includes("role/worker/04-collaboration"));
    const on = await assembleSystemPrompt(deps(), { ...baseCtx, role: "worker", canCollaborate: true });
    assert.ok(on.activeFragmentIds.includes("role/worker/04-collaboration"));
    assert.match(on.text, /Working with peers/);
    assert.doesNotMatch(on.text, /\{\{/); // peer tool-name vars resolved
  });
});
