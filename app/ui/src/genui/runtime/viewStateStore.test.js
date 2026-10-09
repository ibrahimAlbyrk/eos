import { describe, it, expect, vi, beforeEach } from "vitest";

const calls = { get: [], put: [] };
let remote = {};
vi.mock("../../api/client.js", () => ({
  api: {
    getGenuiViewState: vi.fn(async (id) => { calls.get.push(id); return { viewId: id, state: remote, updatedAt: 1 }; }),
    putGenuiViewState: vi.fn(async (id, state) => { calls.put.push([id, state]); return { ok: true, status: 200, body: { viewId: id, state, updatedAt: 2 } }; }),
  },
}));

const store = await import("./viewStateStore.js");
const V = "v_abcdefghijkl";

describe("view state store", () => {
  beforeEach(() => {
    store._reset();
    calls.get.length = 0;
    calls.put.length = 0;
    remote = {};
  });

  it("loads once, writes locally at once and saves the whole state (debounced)", async () => {
    remote = { day: "Pazar" };
    await store.loadViewState(V);
    await store.loadViewState(V);
    expect(calls.get).toEqual([V]);
    expect(store.getViewState(V)).toEqual({ day: "Pazar" });
    store.setViewState(V, "packed", ["a"]);
    store.setViewState(V, "day", "Cumartesi");
    expect(store.getViewState(V)).toEqual({ day: "Cumartesi", packed: ["a"] });
    expect(calls.put).toEqual([]);
    await store._flushPuts();
    expect(calls.put).toEqual([[V, { day: "Cumartesi", packed: ["a"] }]]);
  });

  it("a resync re-reads the views on screen and marks the rest stale for their next mount", async () => {
    const W = "v_mnopqrstuvwx";
    await store.loadViewState(V);
    await store.loadViewState(W);
    const release = store.retainViewState(V);
    calls.get.length = 0;
    store.resyncViewStates();
    await Promise.resolve();
    expect(calls.get).toEqual([V]);
    await store.loadViewState(W);
    expect(calls.get).toEqual([V, W]);
    release();
  });

  it("a remote change keeps the keys this client hasn't saved yet", () => {
    store.setViewState(V, "step", 2);
    store.applyViewStateChange({ viewId: V, state: { step: 0, tab: 1 } });
    expect(store.getViewState(V)).toEqual({ step: 2, tab: 1 });
  });

  it("a remote change replaces state once local edits are saved", async () => {
    store.setViewState(V, "step", 2);
    await store._flushPuts();
    store.applyViewStateChange({ viewId: V, state: { step: 5 } });
    expect(store.getViewState(V)).toEqual({ step: 5 });
  });

  it("a streaming view's local state moves to its id and is saved", async () => {
    store.setViewState("local:toolu_1", "tab", 1);
    store.setSelection("local:toolu_1", "places", "moda");
    expect(calls.put).toEqual([]);
    store.adoptLocalState("local:toolu_1", V);
    expect(store.getViewState(V)).toEqual({ tab: 1 });
    expect(store.getSelection(V)).toEqual({ places: "moda" });
    await store._flushPuts();
    expect(calls.put).toEqual([[V, { tab: 1 }]]);
  });

  it("selection is shared per view and never saved", async () => {
    store.setSelection(V, "places", "lal");
    expect(store.getSelection(V)).toEqual({ places: "lal" });
    await store._flushPuts();
    expect(calls.put).toEqual([]);
  });

  it("ignores changes for views nobody has open, and non-ids", () => {
    store.applyViewStateChange({ viewId: V, state: { a: 1 } });
    expect(store.getViewState(V)).toEqual({});
    store.applyViewStateChange({ viewId: "nope", state: { a: 1 } });
    expect(store.getViewState("nope")).toEqual({});
  });
});
