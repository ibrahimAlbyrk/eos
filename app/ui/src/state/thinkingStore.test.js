import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { applyDelta, liveBlocksFor, dropBlock, dropWorker, finalizeWorker, pruneExcept, subscribe, getBlock } from "./thinkingStore.js";

// Module-level state — keep worker ids unique per assertion to avoid bleed.
let n = 0;
const wid = () => `tw${n++}`;

// applyDelta arms the store's coalescing flush timer (node env has no
// requestAnimationFrame, so it always takes the timer path). Fake timers for the
// whole file so every armed timer is drained deterministically — a pending REAL
// timer would keep the store's flushScheduled latch set across tests.
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
});

describe("thinkingStore", () => {
  it("accumulates delta text by blockId and exposes it per worker", () => {
    const w = wid();
    applyDelta({ workerId: w, blockId: "b0", channel: "reasoning", phase: "start", text: "" });
    applyDelta({ workerId: w, blockId: "b0", channel: "reasoning", phase: "append", text: "hel" });
    applyDelta({ workerId: w, blockId: "b0", channel: "reasoning", phase: "append", text: "lo" });
    const live = liveBlocksFor(w);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ blockId: "b0", channel: "reasoning", text: "hello", done: false });
  });

  it("keeps separate buffers per blockId and per channel", () => {
    const w = wid();
    applyDelta({ workerId: w, blockId: "r0", channel: "reasoning", phase: "append", text: "thinking" });
    applyDelta({ workerId: w, blockId: "t0", channel: "text", phase: "append", text: "answer" });
    const live = liveBlocksFor(w);
    expect(live).toHaveLength(2);
    expect(live.find((b) => b.blockId === "r0")).toMatchObject({ channel: "reasoning", text: "thinking" });
    expect(live.find((b) => b.blockId === "t0")).toMatchObject({ channel: "text", text: "answer" });
  });

  it("phase:stop marks the block done but keeps the buffer until dropped", () => {
    const w = wid();
    applyDelta({ workerId: w, blockId: "b0", channel: "reasoning", phase: "append", text: "x" });
    applyDelta({ workerId: w, blockId: "b0", phase: "stop" });
    const live = liveBlocksFor(w);
    expect(live).toHaveLength(1);
    expect(live[0].done).toBe(true);
  });

  it("dropBlock removes a single buffer; dropWorker removes all of a worker's", () => {
    const w = wid();
    applyDelta({ workerId: w, blockId: "b0", channel: "reasoning", phase: "append", text: "a" });
    applyDelta({ workerId: w, blockId: "b1", channel: "text", phase: "append", text: "b" });
    dropBlock(w, "b0");
    expect(liveBlocksFor(w).map((b) => b.blockId)).toEqual(["b1"]);
    dropWorker(w);
    expect(liveBlocksFor(w)).toHaveLength(0);
  });

  it("finalizeWorker keeps the buffers and marks blocks done+interrupted", () => {
    const w = wid();
    applyDelta({ workerId: w, blockId: "b0", channel: "reasoning", phase: "append", text: "partial thought" });
    finalizeWorker(w);
    const live = liveBlocksFor(w);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ blockId: "b0", text: "partial thought", done: true, interrupted: true });
  });

  it("a new block's first delta drops stale finalized blocks but keeps the new one", () => {
    const w = wid();
    applyDelta({ workerId: w, blockId: "old", channel: "reasoning", phase: "append", text: "interrupted turn" });
    finalizeWorker(w);
    expect(liveBlocksFor(w)).toHaveLength(1); // survives until the next turn
    applyDelta({ workerId: w, blockId: "new", channel: "reasoning", phase: "append", text: "fresh" });
    const live = liveBlocksFor(w);
    expect(live.map((b) => b.blockId)).toEqual(["new"]);
    expect(live[0]).toMatchObject({ text: "fresh", interrupted: false });
  });

  it("dropWorker clears finalized blocks (next turn started via sendToAgent)", () => {
    const w = wid();
    applyDelta({ workerId: w, blockId: "b0", channel: "reasoning", phase: "append", text: "x" });
    finalizeWorker(w);
    dropWorker(w);
    expect(liveBlocksFor(w)).toHaveLength(0);
  });

  it("does not classify an unknown/missing channel as reasoning", () => {
    const w = wid();
    applyDelta({ workerId: w, blockId: "b0", channel: "bogus", phase: "append", text: "x" });
    applyDelta({ workerId: w, blockId: "b1", phase: "append", text: "y" }); // no channel
    const live = liveBlocksFor(w);
    expect(live.find((b) => b.blockId === "b0").channel).not.toBe("reasoning");
    expect(live.find((b) => b.blockId === "b1").channel).not.toBe("reasoning");
    // A later KNOWN channel still updates; an unknown one never overwrites it.
    applyDelta({ workerId: w, blockId: "b0", channel: "reasoning", phase: "append", text: "z" });
    applyDelta({ workerId: w, blockId: "b0", channel: "nope", phase: "append", text: "!" });
    expect(liveBlocksFor(w).find((b) => b.blockId === "b0").channel).toBe("reasoning");
  });

  it("ignores deltas with no workerId or blockId", () => {
    const w = wid();
    applyDelta({ workerId: w, blockId: "", phase: "append", text: "x" });
    applyDelta({ workerId: "", blockId: "b0", phase: "append", text: "x" });
    expect(liveBlocksFor(w)).toHaveLength(0);
  });

  it("pruneExcept drops absent workers but keeps present ones", () => {
    const keep = wid();
    const gone = wid();
    applyDelta({ workerId: keep, blockId: "b0", channel: "reasoning", phase: "append", text: "k" });
    applyDelta({ workerId: gone, blockId: "b0", channel: "reasoning", phase: "append", text: "g" });
    pruneExcept(new Set([keep]));
    expect(liveBlocksFor(keep)).toHaveLength(1);
    expect(liveBlocksFor(gone)).toHaveLength(0);
  });

  it("getBlock returns the accumulated live block by (workerId, blockId)", () => {
    const w = wid();
    applyDelta({ workerId: w, blockId: "b0", channel: "reasoning", phase: "append", text: "ab" });
    applyDelta({ workerId: w, blockId: "b0", channel: "reasoning", phase: "append", text: "c" });
    expect(getBlock(w, "b0")).toMatchObject({ text: "abc", channel: "reasoning" });
    expect(getBlock(w, "nope")).toBeUndefined();
  });
});

// Emission timing — node env has no requestAnimationFrame, so the store falls
// back to its timer flush; fake timers make each flush explicit.
describe("thinkingStore coalesced emit", () => {
  const flushAll = () => vi.runAllTimers();
  const collect = (forWorker) => {
    const calls = [];
    const unsub = subscribe((workerId, structural) => {
      if (workerId === forWorker) calls.push(structural);
    });
    return { calls, unsub };
  };

  it("emits once per flush regardless of delta count; text applies synchronously", () => {
    const w = wid();
    const { calls, unsub } = collect(w);
    applyDelta({ workerId: w, blockId: "b0", channel: "reasoning", phase: "append", text: "a" });
    applyDelta({ workerId: w, blockId: "b0", channel: "reasoning", phase: "append", text: "b" });
    applyDelta({ workerId: w, blockId: "b0", channel: "reasoning", phase: "append", text: "c" });
    expect(getBlock(w, "b0").text).toBe("abc"); // readable before the flush
    expect(calls).toHaveLength(0);              // but no emit yet
    flushAll();
    expect(calls).toHaveLength(1);
    unsub();
  });

  it("classes flushes: block creation is structural, text growth is not", () => {
    const w = wid();
    const { calls, unsub } = collect(w);
    applyDelta({ workerId: w, blockId: "b0", channel: "reasoning", phase: "append", text: "a" });
    flushAll();
    applyDelta({ workerId: w, blockId: "b0", channel: "reasoning", phase: "append", text: "b" });
    applyDelta({ workerId: w, blockId: "b0", phase: "stop" });
    flushAll();
    dropBlock(w, "b0");
    flushAll();
    expect(calls).toEqual([true, false, true]);
    unsub();
  });

  it("keys emits by worker: one flush notifies each streaming worker once", () => {
    const w1 = wid();
    const w2 = wid();
    const seen = [];
    const unsub = subscribe((workerId) => {
      if (workerId === w1 || workerId === w2) seen.push(workerId);
    });
    applyDelta({ workerId: w1, blockId: "b0", channel: "reasoning", phase: "append", text: "x" });
    applyDelta({ workerId: w2, blockId: "b0", channel: "reasoning", phase: "append", text: "y" });
    applyDelta({ workerId: w1, blockId: "b0", channel: "reasoning", phase: "append", text: "x" });
    flushAll();
    expect(seen.sort()).toEqual([w1, w2].sort());
    unsub();
  });

  it("keeps the structural flag when a later delta in the same batch is text-only", () => {
    const w = wid();
    const { calls, unsub } = collect(w);
    applyDelta({ workerId: w, blockId: "b0", channel: "reasoning", phase: "append", text: "a" }); // creates → structural
    applyDelta({ workerId: w, blockId: "b0", channel: "reasoning", phase: "append", text: "b" }); // growth only
    flushAll();
    expect(calls).toEqual([true]);
    unsub();
  });

  it("finalizeWorker emits structural once and is idempotent", () => {
    const w = wid();
    applyDelta({ workerId: w, blockId: "b0", channel: "reasoning", phase: "append", text: "a" });
    flushAll();
    const { calls, unsub } = collect(w);
    finalizeWorker(w);
    flushAll();
    expect(calls).toEqual([true]);
    finalizeWorker(w); // nothing left to change → no emit
    flushAll();
    expect(calls).toEqual([true]);
    unsub();
  });

  it("reclassifying a block's channel is structural (flips live-overlay visibility)", () => {
    const w = wid();
    const { calls, unsub } = collect(w);
    applyDelta({ workerId: w, blockId: "b0", channel: "text", phase: "append", text: "a" });
    flushAll();
    applyDelta({ workerId: w, blockId: "b0", channel: "reasoning", phase: "append", text: "b" });
    flushAll();
    expect(calls).toEqual([true, true]);
    unsub();
  });
});
