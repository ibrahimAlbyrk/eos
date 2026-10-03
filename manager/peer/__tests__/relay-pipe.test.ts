import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { RelayPipe } from "../relay-pipe.ts";

describe("RelayPipe", () => {
  it("sends writes queued behind the one on the wire as one frame", async () => {
    const sent: Buffer[] = [];
    let release: (() => void) | null = null;
    const pipe = new RelayPipe({
      send: (chunk, cb) => { sent.push(chunk); release = () => cb(); },
    });
    pipe.write(Buffer.from("a"));
    pipe.write(Buffer.from("b"));
    pipe.write(Buffer.from("c"));
    assert.deepEqual(sent.map(String), ["a"], "the first goes out at once");
    release!();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sent.map(String), ["a", "bc"], "the queued two leave together");
    release!();
    pipe.destroy();
  });

  it("splits a large burst into bounded frames, in order", async () => {
    const sent: Buffer[] = [];
    const pipe = new RelayPipe({ send: (chunk, cb) => { sent.push(chunk); setImmediate(() => cb()); } });
    pipe.cork();
    for (let i = 0; i < 5; i++) pipe.write(Buffer.alloc(100 * 1024, i));
    pipe.uncork();
    await new Promise((r) => pipe.end(r));
    assert.deepEqual(sent.map((b) => b.length), [200 * 1024, 200 * 1024, 100 * 1024]);
    assert.deepEqual(Buffer.concat(sent), Buffer.concat([0, 1, 2, 3, 4].map((i) => Buffer.alloc(100 * 1024, i))));
  });
});
