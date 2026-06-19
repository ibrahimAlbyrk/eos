import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChildProcessSupervisor } from "../supervision/ChildProcessSupervisor.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";

const silentLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return silentLogger; },
};

const exitCodeOf = (logFile: string, args: string[]): Promise<number | null> =>
  new Promise((resolve) => {
    createChildProcessSupervisor({ binary: "node", logger: silentLogger }).spawn("w", {
      args,
      env: process.env as Record<string, string>,
      logFile,
      onExit: resolve,
    });
  });

test("onExit fires with the child's exit code (happy path)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eos-sup-"));
  try {
    assert.equal(await exitCodeOf(join(dir, "w.log"), ["-e", "process.exit(0)"]), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a log file that cannot be opened degrades — no crash, child still settles", async () => {
  // Non-existent directory → createWriteStream emits 'error'. The supervisor must
  // catch it (guarded out.on('error')) and still run the child, rather than crash
  // the daemon with an unhandled 'error' event.
  assert.equal(await exitCodeOf("/eos-nonexistent-dir-zzz/w.log", ["-e", "process.exit(0)"]), 0);
});
