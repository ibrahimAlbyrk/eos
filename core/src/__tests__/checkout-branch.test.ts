import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkoutBranch } from "../use-cases/CheckoutBranch.ts";
import type { GitInfo } from "../ports/GitInfo.ts";

function fakeGit(opts: { remotes?: string[]; checkoutThrows?: string; stashThrows?: string }) {
  const calls = { checkout: [] as string[], stashPush: 0 };
  const git = {
    remotes: async () => opts.remotes ?? ["origin"],
    stashPush: async () => { calls.stashPush++; if (opts.stashThrows) throw new Error(opts.stashThrows); },
    checkout: async (_cwd: string, branch: string) => {
      calls.checkout.push(branch);
      if (opts.checkoutThrows) throw new Error(opts.checkoutThrows);
    },
  } as unknown as GitInfo;
  return { git, calls };
}

const DIRTY = "Command failed: git -C /r checkout main\nerror: Your local changes to the following files would be overwritten by checkout:\n\tfoo.ts\nPlease commit your changes or stash them before you switch branches.\nAborting";

describe("checkoutBranch", () => {
  it("checks out a local branch", async () => {
    const { git, calls } = fakeGit({});
    assert.deepEqual(await checkoutBranch({ git }, "/r", "feature"), { ok: true });
    assert.deepEqual(calls.checkout, ["feature"]);
  });

  it("strips the remote prefix so git DWIM-creates a tracking branch", async () => {
    const { git, calls } = fakeGit({});
    await checkoutBranch({ git }, "/r", "origin/feature/x");
    assert.deepEqual(calls.checkout, ["feature/x"]);
  });

  it("reports dirty (not a raw error) when local changes block the switch", async () => {
    const { git } = fakeGit({ checkoutThrows: DIRTY });
    const r = await checkoutBranch({ git }, "/r", "main");
    assert.equal(r.ok, false);
    assert.equal(r.dirty, true);
    assert.equal(r.error, undefined);
  });

  it("stashes first when asked, then checks out", async () => {
    const { git, calls } = fakeGit({});
    assert.deepEqual(await checkoutBranch({ git }, "/r", "main", { stash: true }), { ok: true });
    assert.equal(calls.stashPush, 1);
    assert.deepEqual(calls.checkout, ["main"]);
  });

  it("cleans other git errors to a single line (no 'Command failed' echo)", async () => {
    const { git } = fakeGit({ checkoutThrows: "Command failed: git -C /r checkout x\nfatal: invalid reference: x" });
    const r = await checkoutBranch({ git }, "/r", "x");
    assert.equal(r.ok, false);
    assert.equal(r.dirty, undefined);
    assert.equal(r.error, "invalid reference: x");
  });
});
