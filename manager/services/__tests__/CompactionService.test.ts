import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CompactionService, type CompactionServiceDeps } from "../CompactionService.ts";
import type { CompactContextInput, CompactContextResult } from "../../../core/src/use-cases/CompactContext.ts";

type Row = { id: string; state: string; model: string; backend_kind: string; last_context_tokens: number };

function harness(over: { row?: Partial<Row>; enabled?: boolean; threshold?: number; capable?: boolean; result?: CompactContextResult; liveSubagents?: number } = {}) {
  const row: Row = { id: "w1", state: "IDLE", model: "opus", backend_kind: "claude", last_context_tokens: 150_000, ...over.row };
  const runs: CompactContextInput[] = [];
  let settle: (r: CompactContextResult) => void = () => {};
  const deps: CompactionServiceDeps = {
    workers: { findById: () => row as never },
    config: () => ({ enabled: over.enabled ?? true, threshold: over.threshold ?? 0.7 }),
    contextWindowFor: () => 200_000,
    canCompact: () => over.capable ?? true,
    liveSubagents: () => over.liveSubagents ?? 0,
    deferCap: () => 0.95,
    run: (input) => {
      runs.push(input);
      row.state = "WORKING";
      return new Promise<CompactContextResult>((res) => { settle = (r) => { row.state = "IDLE"; res(r); }; });
    },
    log: { info: () => {}, warn: () => {}, error: () => {} } as never,
  };
  const svc = new CompactionService(deps);
  const finish = async (r: CompactContextResult = over.result ?? { ok: true, beforeTokens: 1, afterTokens: 1, turns: 1 }) => {
    settle(r);
    await new Promise((res) => setTimeout(res, 0));
  };
  return { svc, row, runs, finish };
}

describe("CompactionService.checkOnIdle", () => {
  it("starts an auto run at/over the threshold and claims the IDLE edge", () => {
    const h = harness();
    assert.equal(h.svc.checkOnIdle("w1"), true);
    assert.deepEqual(h.runs, [{ workerId: "w1", trigger: "auto" }]);
  });

  it("leaves the edge alone below the threshold, when disabled, or when the lane can't compact", () => {
    assert.equal(harness({ row: { last_context_tokens: 100_000 } }).svc.checkOnIdle("w1"), false);
    assert.equal(harness({ enabled: false }).svc.checkOnIdle("w1"), false);
    assert.equal(harness({ capable: false }).svc.checkOnIdle("w1"), false);
    assert.equal(harness({ row: { state: "WORKING" } }).svc.checkOnIdle("w1"), false);
  });

  it("waits while background subagents run — the restart would kill them", () => {
    assert.equal(harness({ liveSubagents: 2 }).svc.checkOnIdle("w1"), false); // 75%, due but deferred
    assert.equal(harness({ liveSubagents: 0 }).svc.checkOnIdle("w1"), true);
  });

  it("stops waiting for subagents at the cap", () => {
    assert.equal(harness({ liveSubagents: 1, row: { last_context_tokens: 188_000 } }).svc.checkOnIdle("w1"), false); // 94%
    assert.equal(harness({ liveSubagents: 1, row: { last_context_tokens: 190_000 } }).svc.checkOnIdle("w1"), true); // 95%
  });

  it("follows a live threshold change", () => {
    assert.equal(harness({ threshold: 0.8 }).svc.checkOnIdle("w1"), false); // 75% < 80%
    assert.equal(harness({ threshold: 0.5 }).svc.checkOnIdle("w1"), true);
  });

  it("never retries a failed auto run at the same occupancy, but does once the context moved", async () => {
    const h = harness({ result: { ok: false, error: "boom" } });
    assert.equal(h.svc.checkOnIdle("w1"), true);
    await h.finish();
    assert.equal(h.svc.checkOnIdle("w1"), false, "same occupancy → no hot loop");
    h.row.last_context_tokens = 160_000;
    assert.equal(h.svc.checkOnIdle("w1"), true, "a new turn moved the context → try again");
  });
});

describe("CompactionService.start (/compact)", () => {
  it("runs regardless of threshold/enabled, carrying the instructions", () => {
    const h = harness({ enabled: false, row: { last_context_tokens: 10_000 } });
    assert.deepEqual(h.svc.start("w1", "focus on tests"), { ok: true });
    assert.deepEqual(h.runs, [{ workerId: "w1", trigger: "manual", instructions: "focus on tests" }]);
  });

  it("refuses a second run, a busy agent, and an incapable lane", () => {
    const h = harness();
    h.svc.start("w1", "");
    assert.deepEqual(h.svc.start("w1", ""), { ok: false, reason: "a compaction is already running" });
    assert.deepEqual(harness({ row: { state: "WORKING" } }).svc.start("w1", ""), { ok: false, reason: "the agent is busy" });
    assert.deepEqual(harness({ capable: false }).svc.start("w1", ""), { ok: false, reason: "this agent cannot be compacted" });
  });
});

describe("CompactionService.isCompacting", () => {
  it("is true only while the run holds the worker in WORKING", async () => {
    const h = harness();
    assert.equal(h.svc.isCompacting("w1"), false);
    h.svc.checkOnIdle("w1");
    assert.equal(h.svc.isCompacting("w1"), true);
    h.row.state = "IDLE"; // settled to IDLE before the run's promise resolves
    assert.equal(h.svc.isCompacting("w1"), false, "queued messages must drain on that IDLE edge");
    await h.finish();
    assert.equal(h.svc.isCompacting("w1"), false);
  });
});
