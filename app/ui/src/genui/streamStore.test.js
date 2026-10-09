import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  applyGenuiDelta, getStream, streamsFor, dropStream, endWorker, pruneExcept, resyncGenuiStreams, subscribe, _reset, _flush,
} from "./streamStore.js";

const W = "w1";
const NAME = "mcp__orchestrator__present";
const delta = (phase, text = "", callId = "c1") => applyGenuiDelta({ workerId: W, callId, name: NAME, phase, text });

describe("genui stream store", () => {
  beforeEach(() => _reset());

  it("grows a buffer from start → append… → stop", () => {
    delta("start");
    delta("append", '{"title":"Kad');
    delta("append", 'ıköy"');
    expect(getStream(W, "c1").text).toBe('{"title":"Kadıköy"');
    expect(getStream(W, "c1").done).toBe(false);
    delta("stop");
    expect(getStream(W, "c1").done).toBe(true);
    expect(getStream(W, "c1").name).toBe(NAME);
  });

  it("notifies structurally only when a stream starts or goes away", () => {
    const seen = [];
    subscribe((wid, structural) => seen.push([wid, structural]));
    delta("start");
    _flush();
    delta("append", "{");
    _flush();
    dropStream(W, "c1");
    _flush();
    expect(seen).toEqual([[W, true], [W, false], [W, true]]);
  });

  it("an append without its start opens a frozen buffer (the prefix is missing)", () => {
    delta("append", '"ui":"<Map');
    const s = getStream(W, "c1");
    expect(s.frozen).toBe(true);
    expect(s.text).toBe("");
  });

  it("a resync freezes what is still streaming; later appends are ignored", () => {
    delta("start");
    delta("append", '{"title":"A"');
    resyncGenuiStreams();
    delta("append", ',"ui":"x"');
    expect(getStream(W, "c1").text).toBe('{"title":"A"');
    expect(getStream(W, "c1").frozen).toBe(true);
  });

  it("lists a worker's streams and drops an ended turn's leftovers after a grace period", () => {
    vi.useFakeTimers();
    try {
      delta("start", "", "a");
      delta("start", "", "b");
      applyGenuiDelta({ workerId: "w2", callId: "z", name: NAME, phase: "start", text: "" });
      expect(streamsFor(W).map((s) => s.callId).sort()).toEqual(["a", "b"]);
      endWorker(W);
      expect(streamsFor(W)).toHaveLength(2);
      vi.advanceTimersByTime(6000);
      expect(streamsFor(W)).toHaveLength(0);
      expect(streamsFor("w2")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pruneExcept drops the buffers of workers that left the live list", () => {
    delta("start");
    applyGenuiDelta({ workerId: "w2", callId: "c9", name: NAME, phase: "start" });
    pruneExcept(new Set(["w2"]));
    expect(streamsFor(W)).toEqual([]);
    expect(streamsFor("w2")).toHaveLength(1);
  });

  it("ignores deltas without a worker or call id", () => {
    applyGenuiDelta({ phase: "start" });
    applyGenuiDelta({ workerId: W, phase: "append", text: "x" });
    expect(streamsFor(W)).toEqual([]);
  });
});
