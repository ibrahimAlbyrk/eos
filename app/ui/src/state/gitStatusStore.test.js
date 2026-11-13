import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/client.js", () => ({
  api: {
    getWorkerDiff: vi.fn(),
    listBranches: vi.fn(),
    getPushState: vi.fn(),
    watchGitDir: vi.fn(),
    unwatchGitDir: vi.fn(),
  },
}));

import { api } from "../api/client.js";
import { getSnapshot, subscribe, revalidate, ensure, branchesOf, noteWorkerActivity } from "./gitStatusStore.js";
import { emitGitChange, resubscribeGitWatches, subscribeGitChange, BRANCH_KINDS } from "./gitChangeBus.js";

const DIFF = { insertions: 5, deletions: 2, files: 1 };
const BRANCHES = {
  branches: ["main", "dev"], current: "dev", isGit: true,
  remoteUrl: "https://example.com/r", ahead: 3, behind: 1, stash: 2, conflicts: 0,
};
const PUSH = { pushable: true, kind: "fast-forward", hasUncommitted: false };

let nextId = 0;
const freshId = () => `w${nextId++}`;
const freshDir = () => `/repo${nextId++}`;

beforeEach(() => {
  vi.resetAllMocks();
  api.getWorkerDiff.mockResolvedValue(DIFF);
  api.listBranches.mockResolvedValue(BRANCHES);
  api.getPushState.mockResolvedValue(PUSH);
  api.watchGitDir.mockResolvedValue({});
  api.unwatchGitDir.mockResolvedValue({});
});

describe("gitStatusStore", () => {
  it("returns null before first revalidate, snapshot after", async () => {
    const id = freshId();
    expect(getSnapshot(id)).toBeNull();
    await revalidate(id, "/repo");
    expect(getSnapshot(id)).toMatchObject({
      isGit: true, diff: DIFF, currentBranch: "dev", remoteUrl: "https://example.com/r",
      ahead: 3, behind: 1, stash: 2, conflicts: 0,
      pushable: true, pushKind: "fast-forward", hasUncommitted: false,
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

describe("gitStatusStore cache", () => {
  const calls = () => api.getWorkerDiff.mock.calls.length + api.listBranches.mock.calls.length + api.getPushState.mock.calls.length;

  it("showing an agent again sends nothing while its repo is unchanged", async () => {
    const id = freshId();
    const dir = freshDir();
    await ensure(id, dir);
    expect(calls()).toBe(3);
    await ensure(id, dir);
    expect(calls()).toBe(3);
  });

  it("asks again after a git change of its dir", async () => {
    const id = freshId();
    const dir = freshDir();
    await ensure(id, dir);
    emitGitChange(dir, ["worktree"]);
    await ensure(id, dir);
    expect(api.getWorkerDiff).toHaveBeenCalledTimes(2);
  });

  it("asks again after the agent logged something", async () => {
    const id = freshId();
    const dir = freshDir();
    await ensure(id, dir);
    noteWorkerActivity(id);
    await ensure(id, dir);
    expect(api.getWorkerDiff).toHaveBeenCalledTimes(2);
    // The repo itself did not change: its branches answer is reused.
    expect(api.listBranches).toHaveBeenCalledTimes(1);
  });

  it("asks again after the stream reconnects (changes may have gone unheard)", async () => {
    const id = freshId();
    const dir = freshDir();
    await ensure(id, dir);
    resubscribeGitWatches();
    await ensure(id, dir);
    expect(api.getWorkerDiff).toHaveBeenCalledTimes(2);
  });

  it("keeps watching the dirs it answered for last, and lets the oldest go", async () => {
    vi.useFakeTimers();
    const first = freshDir();
    await ensure(freshId(), first);
    expect(api.watchGitDir).toHaveBeenCalledWith(first);
    const later = Array.from({ length: 5 }, freshDir);
    for (const dir of later) await ensure(freshId(), dir);
    vi.runAllTimers();
    vi.useRealTimers();
    const released = api.unwatchGitDir.mock.calls.map(([dir]) => dir);
    expect(released).toContain(first);
    expect(released.filter((dir) => later.includes(dir))).toEqual([]);
  });

  it("a dir it let go counts as changed", async () => {
    const id = freshId();
    const dir = freshDir();
    await ensure(id, dir);
    for (let i = 0; i < 5; i++) await ensure(freshId(), freshDir());
    await ensure(id, dir);
    expect(api.getWorkerDiff.mock.calls.filter(([w]) => w === id)).toHaveLength(2);
  });

  it("one fs/branches for the chips and #branch completion of the same repo", async () => {
    const dir = freshDir();
    const off = subscribeGitChange(dir, BRANCH_KINDS, () => {});
    await Promise.all([branchesOf(dir), ensure(freshId(), dir)]);
    expect(api.listBranches).toHaveBeenCalledTimes(1);
    await branchesOf(dir);
    expect(api.listBranches).toHaveBeenCalledTimes(1);
    off();
  });

  it("a fresh ask skips a cached answer but joins one in flight", async () => {
    const dir = freshDir();
    await branchesOf(dir);
    await branchesOf(dir, { fresh: true });
    expect(api.listBranches).toHaveBeenCalledTimes(2);
    emitGitChange(dir, ["refs"]);
    await Promise.all([branchesOf(dir), branchesOf(dir, { fresh: true })]);
    expect(api.listBranches).toHaveBeenCalledTimes(3);
  });

  it("does not keep a failed fs/branches answer", async () => {
    const dir = freshDir();
    api.listBranches.mockRejectedValueOnce(new Error("network"));
    await expect(branchesOf(dir)).rejects.toThrow("network");
    await expect(branchesOf(dir)).resolves.toEqual(BRANCHES);
    expect(api.listBranches).toHaveBeenCalledTimes(2);
  });
});
