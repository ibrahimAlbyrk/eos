import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/client.js", () => ({
  api: {
    getWorkerDiff: vi.fn(),
    listBranches: vi.fn(),
    getPushState: vi.fn(),
    getTryState: vi.fn(),
  },
}));

import { api } from "../api/client.js";
import { getSnapshot, subscribe, revalidate } from "./gitStatusStore.js";

const DIFF = { insertions: 5, deletions: 2, files: 1 };
const BRANCHES = {
  branches: ["main", "dev"], current: "dev", isGit: true,
  remoteUrl: "https://example.com/r", ahead: 3, behind: 1, stash: 2, conflicts: 0,
};
const PUSH = { pushable: true, kind: "fast-forward", hasUncommitted: false };
const TRY = { activeTry: null, kept: true };

let nextId = 0;
const freshId = () => `w${nextId++}`;

beforeEach(() => {
  vi.resetAllMocks();
  api.getWorkerDiff.mockResolvedValue(DIFF);
  api.listBranches.mockResolvedValue(BRANCHES);
  api.getPushState.mockResolvedValue(PUSH);
  api.getTryState.mockResolvedValue(TRY);
});

describe("gitStatusStore", () => {
  it("returns null before first revalidate, snapshot after", async () => {
    const id = freshId();
    expect(getSnapshot(id)).toBeNull();
    await revalidate(id, "/repo");
    expect(getSnapshot(id)).toMatchObject({
      isGit: true, diff: DIFF, currentBranch: "dev", remoteUrl: "https://example.com/r",
      ahead: 3, behind: 1, stash: 2, conflicts: 0,
      pushable: true, pushKind: "fast-forward", hasUncommitted: false, tryState: TRY,
    });
  });

  it("keeps snapshots isolated per workerId", async () => {
    const a = freshId();
    const b = freshId();
    await revalidate(a, "/repo");
    expect(getSnapshot(a)).not.toBeNull();
    expect(getSnapshot(b)).toBeNull();
  });

  it("notifies subscribers on revalidate and stops after unsubscribe", async () => {
    const id = freshId();
    const cb = vi.fn();
    const un = subscribe(id, cb);
    await revalidate(id, "/repo");
    expect(cb).toHaveBeenCalledTimes(1);
    un();
    await revalidate(id, "/repo");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("dedups concurrent revalidates into one fetch round", async () => {
    const id = freshId();
    let release;
    api.getWorkerDiff.mockReturnValue(new Promise((r) => { release = () => r(DIFF); }));
    const p1 = revalidate(id, "/repo");
    const p2 = revalidate(id, "/repo");
    expect(p2).toBe(p1);
    expect(api.getWorkerDiff).toHaveBeenCalledTimes(1);
    release();
    await p1;
    expect(getSnapshot(id)).not.toBeNull();
  });

  it("keeps the previous snapshot when a fetch throws", async () => {
    const id = freshId();
    await revalidate(id, "/repo");
    const before = getSnapshot(id);
    api.listBranches.mockRejectedValue(new Error("network"));
    await revalidate(id, "/repo");
    expect(getSnapshot(id)).toBe(before);
  });

  it("skips listBranches without a gitDir and assumes git", async () => {
    const id = freshId();
    await revalidate(id, undefined);
    expect(api.listBranches).not.toHaveBeenCalled();
    expect(getSnapshot(id)).toMatchObject({ isGit: true, currentBranch: null, ahead: 0 });
  });

  it("a dirty diff forces isGit even if branches says otherwise", async () => {
    const id = freshId();
    api.listBranches.mockResolvedValue({ ...BRANCHES, isGit: false, current: null });
    await revalidate(id, "/repo");
    expect(getSnapshot(id).isGit).toBe(true);
  });

  it("reports non-git when branches says so and the diff is clean", async () => {
    const id = freshId();
    api.getWorkerDiff.mockResolvedValue({ insertions: 0, deletions: 0, files: 0 });
    api.listBranches.mockResolvedValue({ ...BRANCHES, isGit: false, current: null });
    await revalidate(id, "/repo");
    expect(getSnapshot(id).isGit).toBe(false);
  });
});
