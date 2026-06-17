import { describe, it, expect } from "vitest";
import { applyDelta, liveBlocksFor, dropBlock, dropWorker, pruneExcept } from "./thinkingStore.js";

// Module-level state — keep worker ids unique per assertion to avoid bleed.
let n = 0;
const wid = () => `tw${n++}`;

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
});
