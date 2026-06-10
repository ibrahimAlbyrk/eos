import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSpawnIsolation } from "../domain/worktree-policy.ts";

describe("resolveSpawnIsolation", () => {
  it("downgrades a worktree spawn to plain cwd when worktrees are disabled", () => {
    assert.deepEqual(
      resolveSpawnIsolation({ worktreeFrom: "/repo" }, { worktreesDisabled: true }),
      { cwd: "/repo", worktreeFrom: undefined },
    );
  });

  it("never downgrades an explicit workspaceOf attach", () => {
    assert.deepEqual(
      resolveSpawnIsolation({ worktreeFrom: "/repo", workspaceOf: "w-1" }, { worktreesDisabled: true }),
      { cwd: undefined, worktreeFrom: "/repo" },
    );
  });

  it("passes worktree spawns through when worktrees are enabled", () => {
    assert.deepEqual(
      resolveSpawnIsolation({ worktreeFrom: "/repo" }, { worktreesDisabled: false }),
      { cwd: undefined, worktreeFrom: "/repo" },
    );
  });

  it("leaves plain-cwd spawns untouched regardless of the setting", () => {
    assert.deepEqual(
      resolveSpawnIsolation({ cwd: "/dir" }, { worktreesDisabled: true }),
      { cwd: "/dir", worktreeFrom: undefined },
    );
  });
});
