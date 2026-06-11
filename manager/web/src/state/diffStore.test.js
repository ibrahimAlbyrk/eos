import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/client.js", () => ({
  api: {
    getWorkerChanges: vi.fn(),
    getWorkerFileDiff: vi.fn(),
  },
}));

import { api } from "../api/client.js";
import { getSnapshot, subscribe, revalidate, loadPatch, notifyActivity } from "./diffStore.js";

const FILE = { path: "a.ts", status: "M", insertions: 2, deletions: 1, untracked: false };
const CHANGES = { files: [FILE], insertions: 2, deletions: 1 };
const PATCH = { path: "a.ts", patch: "@@ -1 +1 @@\n-x\n+y\n", binary: false, truncated: false };

let nextId = 0;
const freshId = () => `w${nextId++}`;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
  api.getWorkerChanges.mockResolvedValue(CHANGES);
  api.getWorkerFileDiff.mockResolvedValue(PATCH);
});

describe("diffStore", () => {
  it("starts empty, holds changes after revalidate", async () => {
    const id = freshId();
    expect(getSnapshot(id).changes).toBeNull();
    await revalidate(id);
    expect(getSnapshot(id).changes).toEqual(CHANGES);
  });

  it("caches patches per file and keeps them across revalidates", async () => {
    const id = freshId();
    await revalidate(id);
    await loadPatch(id, FILE);
    expect(getSnapshot(id).patches.get("a.ts")).toEqual({ loading: false, data: PATCH });
    await revalidate(id);
    expect(getSnapshot(id).patches.get("a.ts").data).toEqual(PATCH);
    expect(api.getWorkerFileDiff).toHaveBeenCalledTimes(1);
  });

  it("requests embedded patches and maps them into the patch cache", async () => {
    const id = freshId();
    api.getWorkerChanges.mockResolvedValue({
      files: [{ ...FILE, patch: "@@ -1 +1 @@\n-x\n+y\n", binary: false, truncated: false }],
      insertions: 2, deletions: 1,
    });
    await revalidate(id);
    expect(api.getWorkerChanges).toHaveBeenCalledWith(id, { patches: true });
    const p = getSnapshot(id).patches.get("a.ts");
    expect(p.data.patch).toContain("+y");
    expect(api.getWorkerFileDiff).not.toHaveBeenCalled();
  });

  it("an embedded patch replaces the cached one without a refetch", async () => {
    const id = freshId();
    await revalidate(id);
    await loadPatch(id, FILE);
    api.getWorkerChanges.mockResolvedValue({
      files: [{ ...FILE, insertions: 9, patch: "@@ -1 +1 @@\n-x\n+z\n", binary: false, truncated: false }],
      insertions: 9, deletions: 1,
    });
    await revalidate(id);
    await Promise.resolve();
    expect(getSnapshot(id).patches.get("a.ts").data.patch).toContain("+z");
    expect(api.getWorkerFileDiff).toHaveBeenCalledTimes(1);
  });

  it("refetches a cached patch when its counts moved", async () => {
    const id = freshId();
    await revalidate(id);
    await loadPatch(id, FILE);
    api.getWorkerChanges.mockResolvedValue({
      files: [{ ...FILE, insertions: 5 }], insertions: 5, deletions: 1,
    });
    await revalidate(id);
    await Promise.resolve();
    expect(api.getWorkerFileDiff).toHaveBeenCalledTimes(2);
  });

  it("drops cached patches of files that left the change set", async () => {
    const id = freshId();
    await revalidate(id);
    await loadPatch(id, FILE);
    api.getWorkerChanges.mockResolvedValue({ files: [], insertions: 0, deletions: 0 });
    await revalidate(id);
    expect(getSnapshot(id).patches.size).toBe(0);
  });

  it("keeps stale patch data while reloading", async () => {
    const id = freshId();
    await loadPatch(id, FILE);
    let release;
    api.getWorkerFileDiff.mockReturnValue(new Promise((r) => { release = () => r(PATCH); }));
    loadPatch(id, FILE);
    const mid = getSnapshot(id).patches.get("a.ts");
    expect(mid.loading).toBe(true);
    expect(mid.data).toEqual(PATCH);
    release();
    await Promise.resolve();
  });

  it("dedups concurrent loadPatch calls for the same path", async () => {
    const id = freshId();
    let release;
    api.getWorkerFileDiff.mockReturnValue(new Promise((r) => { release = () => r(PATCH); }));
    loadPatch(id, FILE);
    loadPatch(id, FILE);
    expect(api.getWorkerFileDiff).toHaveBeenCalledTimes(1);
    release();
    await Promise.resolve();
  });

  it("dedups concurrent revalidates", async () => {
    const id = freshId();
    let release;
    api.getWorkerChanges.mockReturnValue(new Promise((r) => { release = () => r(CHANGES); }));
    const p1 = revalidate(id);
    const p2 = revalidate(id);
    expect(p2).toBe(p1);
    expect(api.getWorkerChanges).toHaveBeenCalledTimes(1);
    release();
    await p1;
  });

  it("keeps the previous snapshot when the fetch throws", async () => {
    const id = freshId();
    await revalidate(id);
    const before = getSnapshot(id);
    api.getWorkerChanges.mockRejectedValue(new Error("network"));
    await revalidate(id);
    expect(getSnapshot(id)).toBe(before);
  });

  it("records the error but keeps stale data when a patch reload fails", async () => {
    const id = freshId();
    await loadPatch(id, FILE);
    api.getWorkerFileDiff.mockRejectedValue(new Error("boom"));
    await loadPatch(id, FILE);
    const p = getSnapshot(id).patches.get("a.ts");
    expect(p.error).toBe("boom");
    expect(p.data).toEqual(PATCH);
  });

  it("notifies subscribers and stops after unsubscribe", async () => {
    const id = freshId();
    const cb = vi.fn();
    const un = subscribe(id, cb);
    await revalidate(id);
    expect(cb).toHaveBeenCalled();
    const calls = cb.mock.calls.length;
    un();
    await revalidate(id);
    expect(cb).toHaveBeenCalledTimes(calls);
  });

  it("debounces notifyActivity bursts into one revalidate", async () => {
    vi.useFakeTimers();
    const id = freshId();
    notifyActivity(id);
    notifyActivity(id);
    notifyActivity(id);
    await vi.advanceTimersByTimeAsync(900);
    expect(api.getWorkerChanges).toHaveBeenCalledTimes(1);
  });
});
