import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pruneOrphanScratch, type PruneOrphanScratchDeps } from "../use-cases/PruneOrphanScratch.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";

function buildDeps(rows: Partial<WorkerRow>[], onDisk: string[]): { deps: PruneOrphanScratchDeps; removed: string[] } {
  const removed: string[] = [];
  const deps = {
    workers: { listAll: () => rows as WorkerRow[] },
    scratch: {
      create: async () => { throw new Error("unused"); },
      remove: async (dir: string) => { removed.push(dir); },
      list: () => onDisk,
    },
    log: { info: () => {}, warn: () => {}, error: () => {}, child: () => deps.log },
  } as unknown as PruneOrphanScratchDeps;
  return { deps, removed };
}

describe("pruneOrphanScratch", () => {
  it("removes only folders no row runs in — archived rows keep theirs", async () => {
    const { deps, removed } = buildDeps(
      [
        { cwd: "/s/live", scratch: 1 },
        { cwd: "/s/archived", scratch: 1, archived_at: 5 },
        { cwd: "/s/shared", scratch: 0 },
      ],
      ["/s/live", "/s/archived", "/s/shared", "/s/orphan"],
    );
    await pruneOrphanScratch(deps);
    assert.deepEqual(removed, ["/s/orphan"]);
  });
});
