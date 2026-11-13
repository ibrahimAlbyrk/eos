import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../api/client.js", () => ({
  api: {
    watchGitDir: vi.fn(async () => ({})),
    unwatchGitDir: vi.fn(async () => ({})),
  },
}));

import { api } from "../api/client.js";
import { subscribeGitChange, emitGitChange, resubscribeGitWatches, gitVersion, BRANCH_KINDS } from "./gitChangeBus.js";

// The bus is a module singleton — each case uses its own dir.
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("gitChangeBus watch leases", () => {
  it("leases one daemon watch per dir, released after the last subscriber leaves", () => {
    const off1 = subscribeGitChange("/r/a", BRANCH_KINDS, () => {});
    const off2 = subscribeGitChange("/r/a", BRANCH_KINDS, () => {});
    expect(api.watchGitDir).toHaveBeenCalledTimes(1);
    expect(api.watchGitDir).toHaveBeenCalledWith("/r/a");
    off1();
    off2();
    expect(api.unwatchGitDir).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(api.unwatchGitDir).toHaveBeenCalledTimes(1);
    expect(api.unwatchGitDir).toHaveBeenCalledWith("/r/a");
  });

  it("a quick re-subscribe keeps the lease instead of unwatch + watch", () => {
    subscribeGitChange("/r/b", BRANCH_KINDS, () => {})();
    const off = subscribeGitChange("/r/b", BRANCH_KINDS, () => {});
    vi.runAllTimers();
    expect(api.watchGitDir).toHaveBeenCalledTimes(1);
    expect(api.unwatchGitDir).not.toHaveBeenCalled();
    off();
  });

  it("re-arms live leases on reconnect", () => {
    const off = subscribeGitChange("/r/c", BRANCH_KINDS, () => {});
    api.watchGitDir.mockClear();
    resubscribeGitWatches();
    expect(api.watchGitDir).toHaveBeenCalledWith("/r/c");
    off();
  });
});

describe("gitChangeBus fan-out", () => {
  it("calls back only for wanted kinds (no kinds = refetch)", () => {
    const cb = vi.fn();
    const off = subscribeGitChange("/r/d", BRANCH_KINDS, cb);
    emitGitChange("/r/d", ["worktree"]);
    expect(cb).not.toHaveBeenCalled();
    emitGitChange("/r/d", ["head"]);
    emitGitChange("/r/d", []);
    expect(cb).toHaveBeenCalledTimes(2);
    off();
  });
});

describe("gitChangeBus versions", () => {
  it("renews a dir's version on each change, before its handlers run", () => {
    let seen = null;
    const off = subscribeGitChange("/r/v1", BRANCH_KINDS, () => { seen = gitVersion("/r/v1"); });
    const before = gitVersion("/r/v1");
    expect(before).not.toBeNull();
    emitGitChange("/r/v1", ["head"]);
    expect(seen).not.toBe(before);
    expect(gitVersion("/r/v1")).toBe(seen);
    off();
  });

  it("has no version while no lease is held, and a new one after", () => {
    expect(gitVersion("/r/v2")).toBeNull();
    const off = subscribeGitChange("/r/v2", BRANCH_KINDS, () => {});
    const v = gitVersion("/r/v2");
    off();
    expect(gitVersion("/r/v2")).toBeNull();
    const again = subscribeGitChange("/r/v2", BRANCH_KINDS, () => {});
    expect(gitVersion("/r/v2")).not.toBe(v);
    again();
  });

  it("renews every version on reconnect", () => {
    const off = subscribeGitChange("/r/v3", BRANCH_KINDS, () => {});
    const v = gitVersion("/r/v3");
    resubscribeGitWatches();
    expect(gitVersion("/r/v3")).not.toBe(v);
    off();
  });
});
