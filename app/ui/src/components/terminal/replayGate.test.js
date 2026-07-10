import { describe, it, expect } from "vitest";
import { createReplayGate } from "./replayGate.js";

// A sink that records everything written, in order.
function sink() {
  const out = [];
  const gate = createReplayGate((d) => out.push(d));
  return { gate, out, joined: () => out.join("") };
}

describe("replayGate (reattach ordering + seq dedup)", () => {
  it("writes the replayed buffer before any held live frames", () => {
    const { gate, out } = sink();
    gate.frame({ seq: 3, data: "live-c" }); // arrives before buffer resolves
    gate.frame({ seq: 4, data: "live-d" });
    gate.replay({ seq: 2, data: "SCROLLBACK" });
    expect(out).toEqual(["SCROLLBACK", "live-c", "live-d"]);
  });

  it("drops live frames whose seq the buffer already covers", () => {
    const { gate, out } = sink();
    // Buffer covers up to seq 2; a re-delivered seq<=2 frame must not double-write.
    gate.frame({ seq: 1, data: "dup-a" });
    gate.frame({ seq: 2, data: "dup-b" });
    gate.frame({ seq: 3, data: "new-c" });
    gate.replay({ seq: 2, data: "BUF" });
    expect(out).toEqual(["BUF", "new-c"]);
  });

  it("dedups live frames arriving AFTER replay too", () => {
    const { gate, out } = sink();
    gate.replay({ seq: 5, data: "BUF" });
    gate.frame({ seq: 5, data: "stale" }); // already in buffer
    gate.frame({ seq: 6, data: "fresh" });
    expect(out).toEqual(["BUF", "fresh"]);
  });

  it("with no buffer (fresh session / 404) writes every held frame in order", () => {
    const { gate, out } = sink();
    gate.frame({ seq: 1, data: "a" });
    gate.frame({ seq: 2, data: "b" });
    gate.replay(null);
    gate.frame({ seq: 3, data: "c" });
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("advances lastSeq as live frames pass, so a later stale re-delivery is dropped", () => {
    const { gate, out } = sink();
    gate.replay({ seq: 0, data: "" });
    gate.frame({ seq: 1, data: "one" });
    gate.frame({ seq: 2, data: "two" });
    gate.frame({ seq: 2, data: "two-again" }); // duplicate of the last seq
    gate.frame({ seq: 1, data: "one-again" }); // out-of-order stale
    expect(out).toEqual(["one", "two"]);
  });

  it("tolerates frames without a seq (write them, leave lastSeq untouched)", () => {
    const { gate, out } = sink();
    gate.replay({ seq: 2, data: "BUF" });
    gate.frame({ data: "no-seq" });
    gate.frame({ seq: 3, data: "next" });
    expect(out).toEqual(["BUF", "no-seq", "next"]);
  });

  it("replay is idempotent — a second call writes nothing", () => {
    const { gate, out } = sink();
    gate.replay({ seq: 1, data: "BUF" });
    gate.replay({ seq: 9, data: "AGAIN" });
    expect(out).toEqual(["BUF"]);
  });
});
