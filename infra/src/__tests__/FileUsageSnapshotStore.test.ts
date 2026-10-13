import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileUsageSnapshotStore } from "../usage/FileUsageSnapshotStore.ts";

const snapshot = {
  provider: "claude",
  windows: { fiveHour: { utilization: 41, resetsAt: "2026-07-17T22:50:00Z" } },
  fetchedAt: "2026-07-17T20:00:00Z",
};

describe("FileUsageSnapshotStore", () => {
  const path = () => join(mkdtempSync(join(tmpdir(), "usage-cache-")), "usage-cache.json");

  it("round-trips the snapshots", () => {
    const store = createFileUsageSnapshotStore(path());
    store.save([snapshot]);
    assert.deepEqual(store.load(), [snapshot]);
  });

  it("loads nothing from a missing or unreadable file", () => {
    assert.deepEqual(createFileUsageSnapshotStore(path()).load(), []);
    const bad = path();
    writeFileSync(bad, "{not json");
    assert.deepEqual(createFileUsageSnapshotStore(bad).load(), []);
    writeFileSync(bad, JSON.stringify([{ provider: "claude" }]));
    assert.deepEqual(createFileUsageSnapshotStore(bad).load(), []);
  });
});
