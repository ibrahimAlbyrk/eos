import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPortAllocator } from "../net/PortAllocator.ts";

describe("createPortAllocator", () => {
  it("allocates a port within range", async () => {
    const pa = createPortAllocator({ host: "127.0.0.1", start: 19100, end: 19110 });
    const port = await pa.allocate();
    assert.ok(port >= 19100 && port <= 19110, `port ${port} outside range`);
  });

  it("subsequent allocations return different ports", async () => {
    const pa = createPortAllocator({ host: "127.0.0.1", start: 19200, end: 19210 });
    const a = await pa.allocate();
    const b = await pa.allocate();
    assert.notEqual(a, b);
  });

  it("released port can be re-allocated", async () => {
    const pa = createPortAllocator({ host: "127.0.0.1", start: 19300, end: 19300 });
    const port = await pa.allocate();
    assert.equal(port, 19300);
    // range exhausted now
    await assert.rejects(() => pa.allocate(), /no free port/);
    pa.release(port);
    const again = await pa.allocate();
    assert.equal(again, 19300);
  });

  it("throws when range exhausted", async () => {
    const pa = createPortAllocator({ host: "127.0.0.1", start: 19400, end: 19401 });
    await pa.allocate();
    await pa.allocate();
    await assert.rejects(() => pa.allocate(), /no free port/);
  });
});
