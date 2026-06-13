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
};

// Verifies the DPI assembler selects + composes the right per-role system
// prompt for each spawn scenario. Each role is now a GROUP of concern fragments
// (role/<role>/NN-*) composed in priority order — the assembled text is
// byte-identical to the former monolith, just stored in pieces.
describe("DPI assembles per-role system prompts", () => {
  it("orchestrator → only role/orchestrator/* fragments, intro first", async () => {
    const r = await assembleSystemPrompt(deps(), { ...baseCtx, role: "orchestrator", parentId: null });
    assert.ok(r.activeFragmentIds.length > 1); // split into concern fragments
    assert.ok(r.activeFragmentIds.every((id) => id.startsWith("role/orchestrator/")));
    assert.equal(r.activeFragmentIds[0], "role/orchestrator/01-intro");
    assert.match(r.text, /^# Orchestrator/);
    // Tool-name variables resolve from the registry-backed globals.
    assert.match(r.text, /`spawn_worker`/);
    assert.doesNotMatch(r.text, /\{\{/); // no unresolved {{*_TOOL}} left
  });

  it("orchestrator → swarm playbook embedded in the system prompt (always-on)", async () => {
    const r = await assembleSystemPrompt(deps(), { ...baseCtx, role: "orchestrator", parentId: null });
    assert.ok(r.activeFragmentIds.includes("role/orchestrator/14-swarm-playbook"));
    assert.match(r.text, /# Swarm playbook/); // embedded, not referenced by path
    assert.match(r.text, /## Research swarms/); // research branch present
    assert.doesNotMatch(r.text, /\{\{/); // all tool vars resolved
  });

  it("git agent → only role/git/* fragments", async () => {
    const r = await assembleSystemPrompt(deps(), { ...baseCtx, role: "git" });
    assert.ok(r.activeFragmentIds.every((id) => id.startsWith("role/git/")));
    assert.match(r.text, /^# Git Agent/);
  });

  it("subagent worker (no worktree) → only role/worker/*, zero worktree prose", async () => {
    const r = await assembleSystemPrompt(deps(), { ...baseCtx, role: "worker" });
    assert.ok(r.activeFragmentIds.every((id) => id.startsWith("role/worker/")));
    assert.match(r.text, /^# Worker/);
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
    // env/worktree (layer custom) sorts after every role/worker/* fragment.
    assert.equal(r.activeFragmentIds.at(-1), "env/worktree");
    assert.ok(r.activeFragmentIds.slice(0, -1).every((id) => id.startsWith("role/worker/")));
    assert.match(r.text, /^# Worker/); // role content first
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

  it("collaborate worker → peer-collaboration fragment present; off → absent", async () => {
    const off = await assembleSystemPrompt(deps(), { ...baseCtx, role: "worker" });
    assert.ok(!off.activeFragmentIds.includes("role/worker/04-collaboration"));
    const on = await assembleSystemPrompt(deps(), { ...baseCtx, role: "worker", canCollaborate: true });
    assert.ok(on.activeFragmentIds.includes("role/worker/04-collaboration"));
    assert.match(on.text, /Working with peers/);
    assert.doesNotMatch(on.text, /\{\{/); // peer tool-name vars resolved
  });
});
