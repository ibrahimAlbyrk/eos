import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildShellInvocation, posixShell } from "../platform/posix-shell.ts";

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

describe("posixShell", () => {
  it("opens a login shell, running a command first and staying open after it", () => {
    const prev = process.env.SHELL;
    process.env.SHELL = "/bin/zsh";
    try {
      assert.deepEqual(posixShell.interactive(), { file: "/bin/zsh", args: ["-l"] });
      assert.deepEqual(posixShell.interactive({ command: "top" }), { file: "/bin/zsh", args: ["-l", "-i", "-c", "top; exec '/bin/zsh' -l"] });
      assert.deepEqual(posixShell.interactive({ command: "top", exitAfterCommand: true }), { file: "/bin/zsh", args: ["-l", "-i", "-c", "top"] });
    } finally {
      if (prev === undefined) delete process.env.SHELL;
      else process.env.SHELL = prev;
    }
  });

  it("falls back with ||", () => {
    assert.equal(posixShell.orElse("a", "b"), "a || b");
  });
});
