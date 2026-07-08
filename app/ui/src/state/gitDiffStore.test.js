import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/client.js", () => ({
  api: {
    getGitChanges: vi.fn(),
    getGitFileDiff: vi.fn(),
  },
}));

import { api } from "../api/client.js";
import {
  gitDiffKey, scopeKeyOf, getSnapshot, subscribe, revalidate, loadPatch, notifyActivity, _reset,
} from "./gitDiffStore.js";

const ALL = { kind: "all" };
const commitScope = (sha) => ({ kind: "commit", sha });

const FILE = { path: "a.ts", status: "M", insertions: 2, deletions: 1, untracked: false };
const CHANGES = {
  files: [FILE], insertions: 2, deletions: 1,
  baseSha: "b1", headSha: null, baseLabel: "main", headLabel: "dev",
};
const PATCH = { path: "a.ts", patch: "@@ -1 +1 @@\n-x\n+y\n", binary: false, truncated: false };

beforeEach(() => {
  _reset();
  vi.resetAllMocks();
  vi.useRealTimers();
  api.getGitChanges.mockResolvedValue(CHANGES);
  api.getGitFileDiff.mockResolvedValue(PATCH);
});

describe("gitDiffStore keys", () => {
  it("scopeKeyOf distinguishes all vs commit scopes", () => {
    expect(scopeKeyOf(ALL)).toBe("all");
    expect(scopeKeyOf(commitScope("abc"))).toBe("commit:abc");
    expect(gitDiffKey("/repo", commitScope("abc"))).toBe("/repo commit:abc");
  });
});

describe("gitDiffStore all scope", () => {
  it("starts empty, holds changes after revalidate", async () => {
    expect(getSnapshot(gitDiffKey("/repo", ALL)).changes).toBeNull();
    await revalidate("/repo", ALL);
    expect(getSnapshot(gitDiffKey("/repo", ALL)).changes).toEqual(CHANGES);
    expect(api.getGitChanges).toHaveBeenCalledWith("/repo", { sha: undefined, patches: true });
  });

  it("revalidates again on the next call (working tree is mutable)", async () => {
    await revalidate("/repo", ALL);
    await revalidate("/repo", ALL);
    expect(api.getGitChanges).toHaveBeenCalledTimes(2);
  });

  it("maps embedded patches into the cache; loadPatch fills the rest", async () => {
    api.getGitChanges.mockResolvedValue({
      ...CHANGES,
      files: [{ ...FILE, patch: PATCH.patch, binary: false, truncated: false }],
    });
    await revalidate("/repo", ALL);
    expect(getSnapshot(gitDiffKey("/repo", ALL)).patches.get("a.ts").data.patch).toContain("+y");
    expect(api.getGitFileDiff).not.toHaveBeenCalled();
  });

  it("loadPatch fetches the working-tree diff without a sha", async () => {
    await loadPatch("/repo", ALL, FILE);
    expect(api.getGitFileDiff).toHaveBeenCalledWith("/repo", "a.ts", { oldPath: undefined, sha: undefined });
    expect(getSnapshot(gitDiffKey("/repo", ALL)).patches.get("a.ts")).toEqual({ loading: false, data: PATCH });
  });

  it("keeps the previous snapshot when the fetch throws", async () => {
    await revalidate("/repo", ALL);
    const before = getSnapshot(gitDiffKey("/repo", ALL));
    api.getGitChanges.mockRejectedValue(new Error("network"));
    await revalidate("/repo", ALL);
    expect(getSnapshot(gitDiffKey("/repo", ALL))).toBe(before);
  });

  it("debounces notifyActivity bursts into one revalidate", async () => {
    vi.useFakeTimers();
    notifyActivity("/repo", ALL);
    notifyActivity("/repo", ALL);
    notifyActivity("/repo", ALL);
    await vi.advanceTimersByTimeAsync(900);
    expect(api.getGitChanges).toHaveBeenCalledTimes(1);
  });

  it("notifies subscribers and stops after unsubscribe", async () => {
    const cb = vi.fn();
    const un = subscribe(gitDiffKey("/repo", ALL), cb);
    await revalidate("/repo", ALL);
    expect(cb).toHaveBeenCalled();
    const calls = cb.mock.calls.length;
    un();
    await revalidate("/repo", ALL);
    expect(cb).toHaveBeenCalledTimes(calls);
  });
});

describe("gitDiffStore commit scope", () => {
  it("fetches once with the sha, then treats the entry as immutable", async () => {
    await revalidate("/repo", commitScope("abc"));
    expect(api.getGitChanges).toHaveBeenCalledWith("/repo", { sha: "abc", patches: true });
    await revalidate("/repo", commitScope("abc"));
    expect(api.getGitChanges).toHaveBeenCalledTimes(1);
  });

  it("a failed commit fetch is retryable (nothing cached)", async () => {
    api.getGitChanges.mockRejectedValue(new Error("404"));
    await revalidate("/repo", commitScope("abc"));
    expect(getSnapshot(gitDiffKey("/repo", commitScope("abc"))).changes).toBeNull();
    api.getGitChanges.mockResolvedValue(CHANGES);
    await revalidate("/repo", commitScope("abc"));
    expect(getSnapshot(gitDiffKey("/repo", commitScope("abc"))).changes).toEqual(CHANGES);
  });

  it("loadPatch passes the commit sha through", async () => {
    await loadPatch("/repo", commitScope("abc"), { ...FILE, oldPath: "old.ts" });
    expect(api.getGitFileDiff).toHaveBeenCalledWith("/repo", "a.ts", { oldPath: "old.ts", sha: "abc" });
  });

  it("keeps commit scopes separate per cwd and sha", async () => {
    await revalidate("/repo", commitScope("abc"));
    expect(getSnapshot(gitDiffKey("/repo", commitScope("other"))).changes).toBeNull();
    expect(getSnapshot(gitDiffKey("/elsewhere", commitScope("abc"))).changes).toBeNull();
  });

  it("caps cached commit scopes per cwd at 8, evicting the oldest", async () => {
    for (let i = 0; i < 10; i++) await revalidate("/repo", commitScope(`c${i}`));
    expect(getSnapshot(gitDiffKey("/repo", commitScope("c0"))).changes).toBeNull();
    expect(getSnapshot(gitDiffKey("/repo", commitScope("c1"))).changes).toBeNull();
    expect(getSnapshot(gitDiffKey("/repo", commitScope("c2"))).changes).toEqual(CHANGES);
    expect(getSnapshot(gitDiffKey("/repo", commitScope("c9"))).changes).toEqual(CHANGES);
  });

  it("never evicts a subscribed commit scope", async () => {
    const un = subscribe(gitDiffKey("/repo", commitScope("c0")), () => {});
    for (let i = 0; i < 10; i++) await revalidate("/repo", commitScope(`c${i}`));
    expect(getSnapshot(gitDiffKey("/repo", commitScope("c0"))).changes).toEqual(CHANGES);
    un();
  });

  it("eviction is per cwd — another repo's commits don't count", async () => {
    for (let i = 0; i < 8; i++) await revalidate("/repo", commitScope(`c${i}`));
    for (let i = 0; i < 8; i++) await revalidate("/other", commitScope(`c${i}`));
    expect(getSnapshot(gitDiffKey("/repo", commitScope("c0"))).changes).toEqual(CHANGES);
    expect(getSnapshot(gitDiffKey("/other", commitScope("c0"))).changes).toEqual(CHANGES);
  });
});
