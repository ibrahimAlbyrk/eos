import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { installedWindowsEditors, windowsEditorArgv } from "../filesystem/WindowsFsHelpers.ts";
import { win32Shell } from "../platform/win32-shell.ts";

describe("Windows desktop integration", () => {
  it("opens VS Code and Cursor at a line, other editors at the file", () => {
    assert.deepEqual(windowsEditorArgv("vscode", "C:\\repo\\a.ts", 12, 3), ["--goto", "C:\\repo\\a.ts:12:3"]);
    assert.deepEqual(windowsEditorArgv("cursor", "C:\\repo\\a.ts", 12), ["--goto", "C:\\repo\\a.ts:12"]);
    assert.deepEqual(windowsEditorArgv("vscode", "C:\\repo\\a.ts"), ["C:\\repo\\a.ts"]);
    assert.deepEqual(windowsEditorArgv("zed", "C:\\repo\\a.ts", 4), ["C:\\repo\\a.ts"]);
  });

  it("lists the editors whose executable is installed", () => {
    const editors = installedWindowsEditors((p) => p.endsWith("Code.exe"));
    assert.deepEqual(editors, [{ id: "vscode", name: "Visual Studio Code" }]);
  });
});

describe("PowerShell", () => {
  it("runs a command first and stays open after it", () => {
    assert.deepEqual(win32Shell.interactive({ command: "claude" }).args, ["-NoLogo", "-NoExit", "-Command", "claude"]);
    assert.deepEqual(win32Shell.interactive({ command: "claude", exitAfterCommand: true }).args, ["-NoLogo", "-Command", "claude"]);
    assert.deepEqual(win32Shell.interactive().args, ["-NoLogo"]);
  });

  it("falls back on a failed exit code (Windows PowerShell has no ||)", () => {
    assert.equal(win32Shell.orElse("a", "b"), "a; if ($LASTEXITCODE -ne 0) { b }");
    assert.equal(win32Shell.ttyHooks, false);
  });
});
