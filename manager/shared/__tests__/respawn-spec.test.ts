import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRespawnSpec, type RespawnSpecDeps } from "../respawn-spec.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";

const deps: RespawnSpecDeps = {
  modeResolver: { resolveFor: () => "acceptEdits" },
};

function row(overrides: Partial<WorkerRow>): WorkerRow {
  return {
    id: "w1", state: "SUSPENDED", cwd: "/proj", worktree_from: null, branch: null,
    prompt: "original boot prompt", name: "alpha", pid: null, port: null,
    started_at: 1, ended_at: null, exit_code: null,
    model: "sonnet", effort: "medium", session_id: "s-1",
    ...overrides,
  } as WorkerRow;
}

describe("buildRespawnSpec", () => {
  it("orchestrator: persistent + role preserved (prompt assembled daemon-side)", () => {
    const spec = buildRespawnSpec(row({ is_orchestrator: 1, permission_mode: "default" }), deps);
    assert.equal(spec.systemPromptFile, undefined); // DPI assembles it at spawn
    assert.equal(spec.persistent, true);
    assert.equal(spec.isOrchestrator, true);
    assert.equal(spec.claudePermissionMode, "default");
    assert.equal(spec.prompt, "");
  });

  it("git agent: persistent + role=git", () => {
    const spec = buildRespawnSpec(row({ agent_role: "git", permission_mode: "bypassPermissions" }), deps);
    assert.equal(spec.persistent, true);
    assert.equal(spec.role, "git");
  });

  it("orchestrator-dispatched child: gateway heuristic + mode fallback", () => {
    const spec = buildRespawnSpec(row({ parent_id: "o-1", with_gateway: null, permission_mode: null }), deps);
    assert.equal(spec.persistent, true);
    assert.equal(spec.withGateway, true);
    assert.equal(spec.claudePermissionMode, "acceptEdits");
  });

  it("plain worker: not persistent, explicit with_gateway respected", () => {
    const spec = buildRespawnSpec(row({ with_gateway: 0, permission_mode: "default" }), deps);
    assert.equal(spec.persistent, false);
    assert.equal(spec.withGateway, false);
  });

  it("reattaches by worktree_dir over cwd, never sets worktreeFrom", () => {
    const spec = buildRespawnSpec(row({ worktree_from: "/repo", branch: "eos-x", worktree_dir: "/repo/.eos/worktrees/eos-x" }), deps);
    assert.equal(spec.cwd, "/repo/.eos/worktrees/eos-x");
    assert.equal(spec.worktreeFrom, undefined);
    assert.equal(spec.branch, undefined);
  });
});
