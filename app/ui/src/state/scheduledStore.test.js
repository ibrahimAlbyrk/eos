import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { subscribe, itemsFor, isLoaded, refreshScheduled, _resetScheduled } from "./scheduledStore.js";

const okFetch = (body) =>
  vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });

// Real-Response semantics: the body is single-read. Overlapping same-worker
// refetches dedupe onto one request in the client, so both must share the
// PARSED result — this pins that (mirrors archiveStore's test).
const singleReadFetch = (body) =>
  vi.fn().mockImplementation(async () => {
    let used = false;
    return {
      ok: true,
      status: 200,
      json: async () => {
        if (used) throw new TypeError("Body has already been consumed");
        used = true;
        return body;
      },
    };
  });

const ROW = (id, over = {}) => ({ id, workerId: "w1", text: `msg ${id}`, fireAt: 1000, status: "pending", ...over });

beforeEach(() => _resetScheduled());
afterEach(() => vi.unstubAllGlobals());

describe("scheduledStore", () => {
  it("refreshScheduled populates rows and flips isLoaded", async () => {
    vi.stubGlobal("fetch", okFetch([ROW("a")]));

    expect(isLoaded("w1")).toBe(false);
    await refreshScheduled("w1");

    expect(itemsFor("w1")).toEqual([ROW("a")]);
    expect(isLoaded("w1")).toBe(true);
  });

  it("normalizes an { items } envelope as well as a bare array", async () => {
    vi.stubGlobal("fetch", okFetch({ items: [ROW("a")] }));
    await refreshScheduled("w1");
    expect(itemsFor("w1")).toEqual([ROW("a")]);
  });

  it("keeps rows scoped per worker", async () => {
    vi.stubGlobal("fetch", okFetch([ROW("a")]));
    await refreshScheduled("w1");
    vi.unstubAllGlobals();

    vi.stubGlobal("fetch", okFetch([ROW("b", { workerId: "w2" })]));
    await refreshScheduled("w2");

    expect(itemsFor("w1")).toEqual([ROW("a")]);
    expect(itemsFor("w2")).toEqual([ROW("b", { workerId: "w2" })]);
  });

  it("empties the list when the fetch errors (client is fail-soft → [])", async () => {
    vi.stubGlobal("fetch", okFetch([ROW("a")]));
    await refreshScheduled("w1");
    vi.unstubAllGlobals();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => null }));
    await refreshScheduled("w1");

    expect(itemsFor("w1")).toEqual([]);
  });

  it("overlapping refetches (mount + SSE tick) share one response", async () => {
    vi.stubGlobal("fetch", singleReadFetch([ROW("a")]));
    await Promise.all([refreshScheduled("w1"), refreshScheduled("w1")]);

    expect(itemsFor("w1")).toEqual([ROW("a")]);
    expect(isLoaded("w1")).toBe(true);
  });

  it("itemsFor returns a stable empty reference for an unknown worker", () => {
    expect(itemsFor("nope")).toBe(itemsFor("other"));
    expect(itemsFor("nope")).toEqual([]);
  });

  it("notifies subscribers on refresh", async () => {
    vi.stubGlobal("fetch", okFetch([ROW("a")]));
    const cb = vi.fn();
    subscribe(cb);
    await refreshScheduled("w1");
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
