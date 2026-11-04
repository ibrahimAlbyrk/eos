import { describe, it, expect, vi } from "vitest";
import { dispatchResync, dispatchTopic, onResync, onTopic } from "./liveTopics.js";

describe("liveTopics", () => {
  it("hands a registered topic's payload to its handlers and claims the event", () => {
    const fn = vi.fn();
    const off = onTopic("plugin:local.clock:tick", fn);
    expect(dispatchTopic("plugin:local.clock:tick", { n: 1 })).toBe(true);
    expect(fn).toHaveBeenCalledWith({ n: 1 });
    off();
  });

  it("claims unhandled plugin topics (no workers refetch) but leaves others to useLive", () => {
    expect(dispatchTopic("plugin:gone:x", {})).toBe(true);
    expect(dispatchTopic("worker:change", {})).toBe(false);
  });

  it("a throwing handler doesn't stop the others", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const good = vi.fn();
    const off1 = onTopic("t", () => { throw new Error("boom"); });
    const off2 = onTopic("t", good);
    dispatchTopic("t", 1);
    expect(good).toHaveBeenCalled();
    off1(); off2();
    expect(dispatchTopic("t", 1)).toBe(false);
    err.mockRestore();
  });

  it("runs resync handlers until removed", () => {
    const fn = vi.fn();
    const off = onResync(fn);
    dispatchResync();
    off();
    dispatchResync();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
