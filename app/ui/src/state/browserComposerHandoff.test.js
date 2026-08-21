import { describe, it, expect, beforeEach } from "vitest";
import {
  pushHandoff, getHandoff, consumeHandoff, subscribe, _reset,
} from "./browserComposerHandoff.js";

beforeEach(() => _reset());

describe("browserComposerHandoff", () => {
  it("delivers the attachment only to the keyed pane", () => {
    pushHandoff("A", [{ type: "image", path: "/tmp/a.png" }]);
    expect(getHandoff("A").attachments).toEqual([{ type: "image", path: "/tmp/a.png" }]);
    expect(getHandoff("B")).toBeNull();
  });

  it("consume is a one-shot: the same token clears it, a stale one does not", () => {
    pushHandoff("A", [{ type: "image", path: "/tmp/a.png" }]);
    const first = getHandoff("A");
    // A stale token (from a superseded hand-off) must not clear the live one.
    consumeHandoff("A", "bh-stale");
    expect(getHandoff("A")).not.toBeNull();
    // The live token clears it exactly once.
    consumeHandoff("A", first.token);
    expect(getHandoff("A")).toBeNull();
  });

  it("a fresh hand-off supersedes an un-consumed prior one for the same pane", () => {
    pushHandoff("A", [{ type: "image", path: "/tmp/first.png" }]);
    const stale = getHandoff("A").token;
    pushHandoff("A", [{ type: "image", path: "/tmp/second.png" }]);
    expect(getHandoff("A").attachments[0].path).toBe("/tmp/second.png");
    // The consumer that only saw the stale token can't drop the newer image.
    consumeHandoff("A", stale);
    expect(getHandoff("A").attachments[0].path).toBe("/tmp/second.png");
  });

  it("notifies subscribers on push and consume; ignores empty pushes", () => {
    let ticks = 0;
    const off = subscribe(() => { ticks++; });
    pushHandoff("A", [{ type: "image", path: "/tmp/a.png" }]); // tick 1
    consumeHandoff("A", getHandoff("A").token); // tick 2
    expect(ticks).toBe(2);

    // no attachments / no pane → no-op: no tick, no entry
    pushHandoff("A", []);
    pushHandoff("", [{ type: "image", path: "/tmp/x.png" }]);
    expect(ticks).toBe(2);
    expect(getHandoff("A")).toBeNull();
    off();
  });
});
