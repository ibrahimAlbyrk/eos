import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareJobs, firstLine, formatBytes, transferJobFields } from "../domain/background-jobs.ts";
import type { BackgroundJob } from "../../../contracts/src/background-job.ts";
import type { TransferRecord } from "../../../contracts/src/transfer.ts";

const transfer = (over: Partial<TransferRecord>): TransferRecord => ({
  id: "t1", from: "local", to: "local", origin: { kind: "user" }, sources: ["/a/build", "/a/notes.md"], destDir: "/d", destReason: "default",
  status: "copying", error: null, roots: [], fileCount: 2, totalBytes: 190_840_832, doneBytes: 123_731_968, rate: 12_582_912, route: "direct",
  conflicts: [], decisions: {}, placed: [], createdAt: 1, startedAt: 2, finishedAt: null, ...over,
});

const job = (over: Partial<BackgroundJob>): BackgroundJob => ({
  id: "x", kind: "shell", status: "running", workerId: null, title: "x", command: null, detail: null, startedAt: 0, endedAt: null,
  progress: null, exitCode: null, callId: null, hasOutput: false, canStop: false, ...over,
});

describe("background-jobs domain", () => {
  it("formats bytes the way the rows show them", () => {
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(190_840_832), "182 MB");
  });

  it("takes the first non-empty line, clipped", () => {
    assert.equal(firstLine("\n  hello \nworld"), "hello");
    assert.equal(firstLine("abcdef", 4), "abc…");
    assert.equal(firstLine(""), null);
  });

  it("reads a transfer as a job row", () => {
    assert.deepEqual(transferJobFields(transfer({}), () => "MacBook Air"), {
      status: "running", title: "build +1 → MacBook Air", detail: "118 MB of 182 MB · 12 MB/s",
      progress: { done: 123_731_968, total: 190_840_832 },
    });
    assert.equal(transferJobFields(transfer({ status: "conflict" }), () => "M").detail, "Needs a decision");
    assert.equal(transferJobFields(transfer({ status: "cancelled" }), () => "M").status, "stopped");
    const failed = transferJobFields(transfer({ status: "failed", error: { code: "x", message: "disk full" } }), () => "M");
    assert.deepEqual([failed.status, failed.detail, failed.progress], ["failed", "disk full", null]);
  });

  it("orders running first by start, then finished by end", () => {
    const list = [
      job({ id: "f-old", status: "completed", endedAt: 5 }),
      job({ id: "r-old", startedAt: 1 }),
      job({ id: "f-new", status: "failed", endedAt: 9 }),
      job({ id: "r-new", startedAt: 3 }),
    ].sort(compareJobs);
    assert.deepEqual(list.map((j) => j.id), ["r-new", "r-old", "f-new", "f-old"]);
  });
});
