import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { NodeFileWatcher } from "../filesystem/NodeFileWatcher.ts";
import { systemClock } from "../time/SystemClock.ts";
import { openFdCount } from "../util/fd-stats.ts";
import type { FsChangeEvent } from "../../../core/src/ports/FileWatcher.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 5000, stepMs = 50): Promise<boolean> {
  const deadline = systemClock.now() + timeoutMs;
  while (systemClock.now() < deadline) {
    if (pred()) return true;
    await sleep(stepMs);
  }
  return pred();
}

function setup(files = 0): { dir: string; events: FsChangeEvent[]; w: NodeFileWatcher } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fw-test-")));
  for (let i = 0; i < files; i++) writeFileSync(join(dir, `f${i}.txt`), "x\n");
  const events: FsChangeEvent[] = [];
  const w = new NodeFileWatcher({ clock: systemClock, sink: (batch) => events.push(...batch) });
  return { dir, events, w };
}

describe("NodeFileWatcher", () => {
  it("reports add/change/unlink/addDir/unlinkDir for direct entries", { timeout: 20000 }, async () => {
    const { dir, events, w } = setup(3);
    const saw = (kind: string, name: string): boolean => events.some((e) => e.kind === kind && e.path === join(dir, name));
    try {
      w.watch(dir);
      await sleep(500);

      writeFileSync(join(dir, "f0.txt"), "edited\n");
      assert.ok(await waitFor(() => saw("change", "f0.txt")), "edit → change");

      // Editors save atomically: write a temp file, rename it over the target.
      writeFileSync(join(dir, "f1.txt.tmp"), "saved\n");
      renameSync(join(dir, "f1.txt.tmp"), join(dir, "f1.txt"));
      assert.ok(await waitFor(() => saw("change", "f1.txt")), "atomic save → change");

      writeFileSync(join(dir, "new.txt"), "n\n");
      assert.ok(await waitFor(() => saw("add", "new.txt")), "create → add");

      rmSync(join(dir, "f2.txt"));
      assert.ok(await waitFor(() => saw("unlink", "f2.txt")), "delete → unlink");

      mkdirSync(join(dir, "sub"));
      assert.ok(await waitFor(() => saw("addDir", "sub")), "mkdir → addDir");

      rmSync(join(dir, "sub"), { recursive: true });
      assert.ok(await waitFor(() => saw("unlinkDir", "sub")), "rmdir → unlinkDir");

      for (const e of events) assert.equal(e.dir, dir);
    } finally {
      await w.closeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays shallow and skips ignored entries", { timeout: 10000 }, async () => {
    const { dir, events, w } = setup();
    mkdirSync(join(dir, "sub"));
    try {
      w.watch(dir);
      await sleep(500);
      const mark = events.length;
      writeFileSync(join(dir, "sub", "nested.txt"), "n\n");
      mkdirSync(join(dir, "node_modules"));
      await sleep(700);
      assert.deepEqual(events.slice(mark), [], "nested edits and ignored entries must not fire");
    } finally {
      await w.closeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // chokidar held a kqueue fd per file on macOS; past fd 10240 every child
  // spawn the daemon makes fails EBADF.
  it("watches a dir without a descriptor per file", { skip: process.platform !== "darwin", timeout: 10000 }, async () => {
    const { dir, w } = setup(500);
    try {
      const before = openFdCount()!;
      w.watch(dir);
      await sleep(500);
      const opened = openFdCount()! - before;
      assert.ok(opened < 20, `watch opened ${opened} fds for a 500-file dir`);
    } finally {
      await w.closeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
