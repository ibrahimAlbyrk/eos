import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildShellInvocation } from "../shell-invocation.ts";

describe("buildShellInvocation", () => {
  it("zsh gets -i so .zshrc is sourced", () => {
    assert.deepEqual(buildShellInvocation("/bin/zsh", "echo hi"), {
      file: "/bin/zsh",
      args: ["-i", "-l", "-c", "echo hi"],
    });
  });

  it("bash stays login-only (no -i: job-control noise without a TTY)", () => {
    assert.deepEqual(buildShellInvocation("/bin/bash", "echo hi"), {
      file: "/bin/bash",
      args: ["-l", "-c", "echo hi"],
    });
  });

  it("fish uses login flags (config.fish is always read)", () => {
    assert.deepEqual(buildShellInvocation("/opt/homebrew/bin/fish", "ls"), {
      file: "/opt/homebrew/bin/fish",
      args: ["-l", "-c", "ls"],
    });
  });

  it("unknown shells fall back to login-only flags", () => {
    assert.deepEqual(buildShellInvocation("/opt/weird/shell", "ls"), {
      file: "/opt/weird/shell",
      args: ["-l", "-c", "ls"],
    });
  });
});
