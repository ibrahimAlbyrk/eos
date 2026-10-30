import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateFileCache, listCandidateFiles } from "../filesystem/gitCandidateFiles.ts";

describe("listCandidateFiles", () => {
  let repo: string;
  let plain: string;

  before(() => {
    repo = mkdtempSync(join(tmpdir(), "eos-cand-git-"));
    spawnSync("git", ["-C", repo, "init"], { encoding: "utf8" });
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "a.ts"), "");
    writeFileSync(join(repo, "z.ts"), "");
    writeFileSync(join(repo, ".gitignore"), "ignored.ts\n");
    spawnSync("git", ["-C", repo, "add", "-A"], { encoding: "utf8" });
    writeFileSync(join(repo, "b-untracked.ts"), "");
    writeFileSync(join(repo, "çay ö.ts"), "");
    writeFileSync(join(repo, "ignored.ts"), "");

    plain = mkdtempSync(join(tmpdir(), "eos-cand-walk-"));
    mkdirSync(join(plain, "sub", "node_modules"), { recursive: true });
    mkdirSync(join(plain, ".hidden"));
    writeFileSync(join(plain, "top.ts"), "");
    writeFileSync(join(plain, "sub", "deep.ts"), "");
    writeFileSync(join(plain, "sub", "node_modules", "dep.js"), "");
    writeFileSync(join(plain, ".hidden", "x.ts"), "");
  });

  after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  });

  it("lists tracked files, then untracked ones, without ignored files", async () => {
    assert.deepEqual(await listCandidateFiles(repo), [".gitignore", "src/a.ts", "z.ts", "b-untracked.ts", "çay ö.ts"]);
  });

  it("walks a non-git root, skipping dot and ignored entries", async () => {
    assert.deepEqual((await listCandidateFiles(plain)).sort(), ["sub/deep.ts", "top.ts"]);
  });
});

describe("CandidateFileCache", () => {
  function fixture() {
    let now = 0;
    const calls: string[] = [];
    const cache = new CandidateFileCache({
      clock: { now: () => now },
      list: async (root) => {
        calls.push(root);
        return [`${root}/f${calls.length}`];
      },
    });
    return { cache, calls, advance: (ms: number) => { now += ms; } };
  }

  it("lists a root once, concurrent callers included", async () => {
    const { cache, calls } = fixture();
    const [a, b] = await Promise.all([cache.list("/r"), cache.list("/r")]);
    assert.deepEqual(a, ["/r/f1"]);
    assert.equal(a, b);
    assert.deepEqual(await cache.list("/r"), ["/r/f1"]);
    assert.deepEqual(calls, ["/r"]);
  });

  it("re-lists after invalidate()", async () => {
    const { cache, calls } = fixture();
    await cache.list("/r");
    cache.invalidate("/r");
    assert.deepEqual(cache.roots(), []);
    assert.deepEqual(await cache.list("/r"), ["/r/f2"]);
    assert.equal(calls.length, 2);
  });

  it("re-lists once the TTL has passed", async () => {
    const { cache, calls, advance } = fixture();
    await cache.list("/r");
    advance(9_999);
    await cache.list("/r");
    assert.equal(calls.length, 1);
    advance(1);
    assert.deepEqual(await cache.list("/r"), ["/r/f2"]);
  });

  it("keeps the 8 most recently used roots", async () => {
    const { cache } = fixture();
    for (let i = 0; i < 8; i++) await cache.list(`/r${i}`);
    await cache.list("/r0");
    await cache.list("/r8");
    assert.deepEqual(cache.roots(), ["/r2", "/r3", "/r4", "/r5", "/r6", "/r7", "/r0", "/r8"]);
  });
});
