import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoCommandRunner } from "../goalcheck/MemoCommandRunner.ts";

const dir = (): string => mkdtempSync(join(tmpdir(), "eos-memorun-"));

describe("createMemoCommandRunner", () => {
  it("executes each (cmd, cwd) exactly once — a repeat call replays the cached result", async () => {
    const d = dir();
    const hits = join(d, "hits");
    const runner = createMemoCommandRunner();
    const cmd = `printf x >> ${hits}`;
    const r1 = await runner.run(cmd, d);
    const r2 = await runner.run(cmd, d);
    assert.equal(r1.exitCode, 0);
    assert.equal(r2.exitCode, 0);
    assert.equal(readFileSync(hits, "utf8"), "x"); // ran ONCE despite two calls
  });

  it("concurrent calls share the in-flight execution (no double spawn)", async () => {
    const d = dir();
    const hits = join(d, "hits");
    const runner = createMemoCommandRunner();
    const cmd = `printf x >> ${hits}`;
    await Promise.all([runner.run(cmd, d), runner.run(cmd, d), runner.run(cmd, d)]);
    assert.equal(readFileSync(hits, "utf8"), "x");
  });

  it("(cmd, cwd) is the key — the same command in a different cwd executes separately", async () => {
    const d1 = dir();
    const d2 = dir();
    const runner = createMemoCommandRunner();
    const cmd = "printf x >> hits";
    await runner.run(cmd, d1);
    await runner.run(cmd, d2);
    assert.ok(existsSync(join(d1, "hits")));
    assert.ok(existsSync(join(d2, "hits")));
  });

  it("never caches an aborted result — a later call actually runs the command", async () => {
    const d = dir();
    const hits = join(d, "hits");
    const runner = createMemoCommandRunner();
    const cmd = `printf x >> ${hits}`;
    const ac = new AbortController();
    ac.abort();
    const aborted = await runner.run(cmd, d, ac.signal);
    assert.equal(aborted.aborted, true);
    assert.equal(existsSync(hits), false); // aborted → no side effect
    const rerun = await runner.run(cmd, d); // same key, no signal
    assert.equal(rerun.aborted, undefined); // NOT the cached aborted result
    assert.equal(readFileSync(hits, "utf8"), "x"); // it really executed this time
  });
});
