import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { delimiter } from "node:path";
import { appendToPath } from "../util/path-env.ts";
import { win32Platform } from "../platform/win32.ts";
import { darwinPlatform } from "../platform/darwin.ts";

describe("appendToPath", () => {
  it("appends the dir after the user's own entries", () => {
    assert.equal(appendToPath({ PATH: `/usr/bin${delimiter}/bin` }, "/eos").PATH, `/usr/bin${delimiter}/bin${delimiter}/eos`);
  });

  it("keeps Windows' own spelling of the key, and adds no second one", () => {
    const env = appendToPath({ Path: "C:\\Windows" }, "C:\\Eos");
    assert.equal(env.Path, `C:\\Windows${delimiter}C:\\Eos`);
    assert.equal(env.PATH, undefined);
  });

  it("leaves an env that already reaches the dir alone, and starts one that has no PATH", () => {
    const env = { PATH: "/eos" };
    assert.equal(appendToPath(env, "/eos"), env);
    assert.equal(appendToPath({}, "/eos").PATH, "/eos");
  });
});

describe("CLI executables", () => {
  it("looks for a native build, then npm's .cmd shim, on Windows", () => {
    assert.deepEqual(win32Platform.executableNames("codex"), ["codex.exe", "codex.cmd"]);
    assert.deepEqual(darwinPlatform.executableNames("codex"), ["codex"]);
  });

  it("starts a .cmd through cmd, quoting what cmd would split", () => {
    const c = win32Platform.spawnCommand("C:\\Users\\Me Too\\AppData\\Roaming\\npm\\gemini.cmd", ["--acp", "--policy", "C:\\Users\\Me Too\\.eos\\p.toml"]);
    assert.equal(c.windowsVerbatimArguments, true);
    assert.deepEqual(c.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(c.args[3], '""C:\\Users\\Me Too\\AppData\\Roaming\\npm\\gemini.cmd" --acp --policy "C:\\Users\\Me Too\\.eos\\p.toml""');
  });

  it("starts an .exe as is", () => {
    assert.deepEqual(win32Platform.spawnCommand("C:\\x\\codex.exe", ["login"]), { file: "C:\\x\\codex.exe", args: ["login"] });
  });
});
