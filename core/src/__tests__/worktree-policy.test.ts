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

  it("a type's cwd isolation downgrades a worktree spawn", () => {
    assert.deepEqual(
      resolveSpawnIsolation({ worktreeFrom: "/repo" }, { worktreesDisabled: false, typeIsolation: "cwd" }),
      { cwd: "/repo", worktreeFrom: undefined },
    );
  });

  it("a type's worktree isolation promotes a plain-cwd spawn", () => {
    assert.deepEqual(
      resolveSpawnIsolation({ cwd: "/repo" }, { worktreesDisabled: false, typeIsolation: "worktree" }),
      { cwd: undefined, worktreeFrom: "/repo" },
    );
  });

  it("global worktrees-disabled wins over a type's worktree preference", () => {
    assert.deepEqual(
      resolveSpawnIsolation({ cwd: "/repo" }, { worktreesDisabled: true, typeIsolation: "worktree" }),
      { cwd: "/repo", worktreeFrom: undefined },
    );
  });

  it("a type's worktree preference does not re-decide an explicit attach", () => {
    assert.deepEqual(
      resolveSpawnIsolation({ cwd: "/x", workspaceOf: "w-1" }, { worktreesDisabled: false, typeIsolation: "worktree" }),
      { cwd: "/x", worktreeFrom: undefined },
    );
  });

  it("a worktree spawn already matching the type's worktree preference is unchanged", () => {
    assert.deepEqual(
      resolveSpawnIsolation({ worktreeFrom: "/repo" }, { worktreesDisabled: false, typeIsolation: "worktree" }),
      { cwd: undefined, worktreeFrom: "/repo" },
    );
  });
});
