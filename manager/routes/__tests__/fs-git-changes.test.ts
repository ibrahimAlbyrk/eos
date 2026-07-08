// Git Diff panel routes: scope derivation, sha mode, patch embedding, and the
// blob guards — against a recording fake GitInfo (the real-git behavior of the
// port methods is covered in infra/src/__tests__/git-info-scope.test.ts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Router } from "../Router.ts";
import { registerFsGitRoutes } from "../fs-git.ts";
import type { Container } from "../../container.ts";
import type { RouteContext } from "../Router.ts";
import { ValidationError } from "../../../core/src/errors/index.ts";
import {
  FsLogQuerySchema,
  FsLogResponseSchema,
  FsChangesQuerySchema,
  FsChangesResponseSchema,
  FsChangesFileQuerySchema,
  FsBlobQuerySchema,
  FsStashesResponseSchema,
  FsStashApplyRequestSchema,
  FsStashDropRequestSchema,
  FsCheckoutResponseSchema,
  type ChangedFile,
  type CommitDetail,
  type FsStashEntry,
  type UnpushedCommit,
} from "../../../contracts/src/http.ts";

const COMMIT = (n: number): UnpushedCommit => ({ sha: `sha${n}`, author: "t", ts: n * 1000, subject: `c${n}` });

const TWO_FILE_DIFF = [
  "diff --git a/a.txt b/a.txt",
  "index 1111111..2222222 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1 +1 @@",
  "-alpha",
  "+alpha changed",
  "diff --git a/b.txt b/b.txt",
  "index 3333333..4444444 100644",
  "--- a/b.txt",
  "+++ b/b.txt",
  "@@ -1 +1 @@",
  "-bravo",
  "+bravo changed",
  "",
].join("\n");

const DETAIL: CommitDetail = {
  sha: "abc1234", author: "t", ts: 1000, subject: "touch both", body: "",
  insertions: 2, deletions: 2,
  files: [
    { path: "a.txt", status: "M", insertions: 1, deletions: 1 },
    { path: "b.txt", status: "M", insertions: 1, deletions: 1 },
  ],
};

const CHANGED: ChangedFile[] = [
  { path: "a.txt", status: "M", untracked: false, insertions: 1, deletions: 1 },
  { path: "b.txt", status: "M", untracked: false, insertions: 1, deletions: 1 },
];

interface FakeGitOpts {
  head?: string | null;
  toplevel?: string | null;
  logRows?: UnpushedCommit[];
  detail?: CommitDetail | null;
  blobSize?: number | null;
  blob?: Uint8Array | null;
  stashes?: FsStashEntry[];
  stashApplyResult?: { ok: boolean; error?: string };
  stashDropResult?: { ok: boolean; error?: string };
}

function fakeContainer(opts: FakeGitOpts = {}) {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const rec = (fn: string, args: unknown[]) => { calls.push({ fn, args }); };
  const git = {
    currentBranch: async (...a: unknown[]) => { rec("currentBranch", a); return opts.head === undefined ? "feat" : opts.head; },
    gitDirs: async (...a: unknown[]) => {
      rec("gitDirs", a);
      const top = opts.toplevel === undefined ? "/repos/eos" : opts.toplevel;
      return top === null ? null : { toplevel: top, gitDir: `${top}/.git`, commonDir: `${top}/.git` };
    },
    revParse: async (...a: unknown[]) => { rec("revParse", a); return `short:${a[1]}`; },
    changedFiles: async (...a: unknown[]) => { rec("changedFiles", a); return CHANGED.map((f) => ({ ...f })); },
    fullDiff: async (...a: unknown[]) => { rec("fullDiff", a); return TWO_FILE_DIFF; },
    fileDiff: async (...a: unknown[]) => { rec("fileDiff", a); return { path: a[1], patch: "p", binary: false, truncated: false }; },
    log: async (...a: unknown[]) => { rec("log", a); return (opts.logRows ?? []).map((r) => ({ ...r })); },
    commitDetail: async (...a: unknown[]) => { rec("commitDetail", a); return opts.detail === undefined ? DETAIL : opts.detail; },
    commitPatch: async (...a: unknown[]) => { rec("commitPatch", a); return TWO_FILE_DIFF; },
    commitFileDiff: async (...a: unknown[]) => { rec("commitFileDiff", a); return { path: a[2], patch: "cp", binary: false, truncated: false }; },
    blobSizeAtRef: async (...a: unknown[]) => { rec("blobSizeAtRef", a); return opts.blobSize === undefined ? 4 : opts.blobSize; },
    blobAtRef: async (...a: unknown[]) => { rec("blobAtRef", a); return opts.blob === undefined ? new Uint8Array([1, 2, 3, 4]) : opts.blob; },
    stashList: async (...a: unknown[]) => { rec("stashList", a); return (opts.stashes ?? []).map((s) => ({ ...s })); },
    stashApply: async (...a: unknown[]) => { rec("stashApply", a); return opts.stashApplyResult ?? { ok: true }; },
    stashDrop: async (...a: unknown[]) => { rec("stashDrop", a); return opts.stashDropResult ?? { ok: true }; },
  };
  const c = { git, uiToken: "tok" } as unknown as Container;
  return { c, calls };
}

async function post(c: Container, path: string, body: unknown, headers: Record<string, string> = {}) {
  const router = new Router();
  registerFsGitRoutes(router, c);
  const u = new URL("http://x" + path);
  const m = router.match("POST", u.pathname);
  assert.ok(m, `no POST route matched ${u.pathname}`);
  const req = Object.assign(Readable.from([JSON.stringify(body)]), { headers }) as unknown as RouteContext["req"];
  let status = 0;
  let payload: unknown;
  const res = {
    req: { headers: {} },
    writeHead: (s: number) => { status = s; },
    end: (b?: string) => { payload = b ? JSON.parse(b) : undefined; },
  } as unknown as RouteContext["res"];
  await m.handler({ params: m.params, url: u, req, res } as RouteContext);
  return { status, payload: payload as Record<string, unknown> };
}

const TOKEN = { "x-eos-ui-token": "tok" };

async function get(c: Container, path: string) {
  const router = new Router();
  registerFsGitRoutes(router, c);
  const u = new URL("http://x" + path);
  const m = router.match("GET", u.pathname);
  assert.ok(m, `no GET route matched ${u.pathname}`);
  let status = 0;
  let headers: Record<string, string> = {};
  let raw: unknown;
  const res = {
    req: { headers: {} },
    writeHead: (s: number, h?: Record<string, string>) => { status = s; headers = h ?? {}; },
    end: (b?: unknown) => { raw = b; },
  } as unknown as RouteContext["res"];
  await m.handler({ params: m.params, url: u, res } as RouteContext);
  const payload = typeof raw === "string" ? JSON.parse(raw) : raw;
  return { status, headers, payload };
}

describe("fs git diff panel schemas (zod round-trips)", () => {
  it("FsLogQuerySchema coerces + defaults + caps", () => {
    assert.deepEqual(FsLogQuerySchema.parse({ cwd: "/r" }), { cwd: "/r", limit: 30, skip: 0 });
    assert.deepEqual(FsLogQuerySchema.parse({ cwd: "/r", limit: "10", skip: "5" }), { cwd: "/r", limit: 10, skip: 5 });
    assert.throws(() => FsLogQuerySchema.parse({ cwd: "/r", limit: "500" }));
    assert.throws(() => FsLogQuerySchema.parse({ cwd: "/r", skip: "-1" }));
  });

  it("FsLogResponseSchema round-trips", () => {
    const body = { commits: [COMMIT(1)], hasMore: true };
    assert.deepEqual(FsLogResponseSchema.parse(body), body);
  });

  it("FsChangesQuerySchema accepts hex shas only", () => {
    assert.deepEqual(FsChangesQuerySchema.parse({ cwd: "/r", sha: "AbC123" }), { cwd: "/r", sha: "AbC123" });
    assert.deepEqual(FsChangesQuerySchema.parse({ cwd: "/r" }), { cwd: "/r" });
    assert.throws(() => FsChangesQuerySchema.parse({ cwd: "/r", sha: "main" }));
    assert.throws(() => FsChangesQuerySchema.parse({ cwd: "/r", sha: "ab" })); // too short
  });

  it("FsChangesResponseSchema extends the worker changes shape with scope", () => {
    const body = {
      files: CHANGED, insertions: 2, deletions: 2,
      baseSha: "aaa", headSha: null, baseLabel: null, headLabel: "feat", repoLabel: "eos",
    };
    assert.deepEqual(FsChangesResponseSchema.parse(body), body);
    assert.throws(() => FsChangesResponseSchema.parse({ files: [], insertions: 0, deletions: 0 }));
  });

  it("FsChangesFileQuerySchema requires path; sha hex-only", () => {
    assert.deepEqual(
      FsChangesFileQuerySchema.parse({ cwd: "/r", path: "a.txt", oldPath: "b.txt", sha: "abcd" }),
      { cwd: "/r", path: "a.txt", oldPath: "b.txt", sha: "abcd" },
    );
    assert.throws(() => FsChangesFileQuerySchema.parse({ cwd: "/r" }));
    assert.throws(() => FsChangesFileQuerySchema.parse({ cwd: "/r", path: "a", sha: "HEAD" }));
  });

  it("FsBlobQuerySchema rejects symbolic refs", () => {
    assert.deepEqual(FsBlobQuerySchema.parse({ cwd: "/r", ref: "abcd1234", path: "img.png" }), { cwd: "/r", ref: "abcd1234", path: "img.png" });
    assert.throws(() => FsBlobQuerySchema.parse({ cwd: "/r", ref: "HEAD", path: "img.png" }));
    assert.throws(() => FsBlobQuerySchema.parse({ cwd: "/r", ref: "main", path: "img.png" }));
  });

  it("FsStashApply/DropRequestSchema require a nonnegative int index", () => {
    assert.deepEqual(FsStashApplyRequestSchema.parse({ cwd: "/r", index: 0 }), { cwd: "/r", index: 0 });
    assert.deepEqual(FsStashDropRequestSchema.parse({ cwd: "/r", index: 2 }), { cwd: "/r", index: 2 });
    assert.throws(() => FsStashApplyRequestSchema.parse({ cwd: "/r", index: -1 }));
    assert.throws(() => FsStashDropRequestSchema.parse({ cwd: "/r", index: 1.5 }));
    assert.throws(() => FsStashApplyRequestSchema.parse({ cwd: "/r" }));
  });
});

describe("GET /fs/stashes", () => {
  const STASH: FsStashEntry = { index: 0, sha: "abc123", subject: "WIP on main: x", ts: 1000, branch: "main" };

  it("returns the stash list from the port", async () => {
    const { c, calls } = fakeContainer({ stashes: [STASH] });
    const out = await get(c, "/fs/stashes?cwd=/repo");
    assert.equal(out.status, 200);
    const body = FsStashesResponseSchema.parse(out.payload);
    assert.deepEqual(body.stashes, [STASH]);
    assert.deepEqual(calls.find((x) => x.fn === "stashList")?.args, ["/repo"]);
  });

  it("empty stash → { stashes: [] }", async () => {
    const { c } = fakeContainer();
    const body = FsStashesResponseSchema.parse((await get(c, "/fs/stashes?cwd=/repo")).payload);
    assert.deepEqual(body.stashes, []);
  });

  it("rejects a relative cwd", async () => {
    const { c } = fakeContainer();
    assert.equal((await get(c, "/fs/stashes?cwd=repo")).status, 400);
  });
});

describe("POST /fs/stash/apply · /fs/stash/drop", () => {
  it("apply: with token → calls stashApply(cwd,index), returns the result", async () => {
    const { c, calls } = fakeContainer();
    const out = await post(c, "/fs/stash/apply", { cwd: "/repo", index: 1 }, TOKEN);
    assert.equal(out.status, 200);
    assert.deepEqual(FsCheckoutResponseSchema.parse(out.payload), { ok: true });
    assert.deepEqual(calls.find((x) => x.fn === "stashApply")?.args, ["/repo", 1]);
  });

  it("apply: conflict result passes through as { ok:false, error }", async () => {
    const { c } = fakeContainer({ stashApplyResult: { ok: false, error: "CONFLICT (content): merge conflict" } });
    const out = await post(c, "/fs/stash/apply", { cwd: "/repo", index: 0 }, TOKEN);
    assert.equal(out.status, 200);
    assert.equal(out.payload.ok, false);
    assert.match(String(out.payload.error), /CONFLICT/);
  });

  it("drop: with token → calls stashDrop(cwd,index)", async () => {
    const { c, calls } = fakeContainer();
    const out = await post(c, "/fs/stash/drop", { cwd: "/repo", index: 2 }, TOKEN);
    assert.equal(out.status, 200);
    assert.deepEqual(calls.find((x) => x.fn === "stashDrop")?.args, ["/repo", 2]);
  });

  it("missing UI token → 403, port not called", async () => {
    const { c, calls } = fakeContainer();
    const apply = await post(c, "/fs/stash/apply", { cwd: "/repo", index: 0 });
    const drop = await post(c, "/fs/stash/drop", { cwd: "/repo", index: 0 });
    assert.equal(apply.status, 403);
    assert.equal(drop.status, 403);
    assert.equal(calls.find((x) => x.fn === "stashApply"), undefined);
    assert.equal(calls.find((x) => x.fn === "stashDrop"), undefined);
  });

  it("relative cwd → 400", async () => {
    const { c } = fakeContainer();
    assert.equal((await post(c, "/fs/stash/apply", { cwd: "repo", index: 0 }, TOKEN)).status, 400);
  });
});

describe("GET /fs/log", () => {
  it("slices to limit and reports hasMore from the overflow row", async () => {
    const { c, calls } = fakeContainer({ logRows: [COMMIT(3), COMMIT(2), COMMIT(1)] });
    const out = await get(c, "/fs/log?cwd=/repo&limit=2");
    assert.equal(out.status, 200);
    const body = FsLogResponseSchema.parse(out.payload);
    assert.deepEqual(body.commits.map((x) => x.subject), ["c3", "c2"]);
    assert.equal(body.hasMore, true);
    assert.deepEqual(calls[0], { fn: "log", args: ["/repo", { limit: 2, skip: 0 }] });
  });

  it("hasMore=false when the page isn't full", async () => {
    const { c } = fakeContainer({ logRows: [COMMIT(1)] });
    const body = FsLogResponseSchema.parse((await get(c, "/fs/log?cwd=/repo&limit=2&skip=4")).payload);
    assert.deepEqual(body.commits.map((x) => x.subject), ["c1"]);
    assert.equal(body.hasMore, false);
  });

  it("rejects a relative cwd", async () => {
    const { c } = fakeContainer();
    assert.equal((await get(c, "/fs/log?cwd=repo")).status, 400);
  });
});

describe("GET /fs/changes (local-changes-only scope)", () => {
  it("diffs vs HEAD with no base ref; labels + repoLabel resolved", async () => {
    const { c, calls } = fakeContainer({ head: "feat" });
    const out = await get(c, "/fs/changes?cwd=/repo");
    assert.equal(out.status, 200);
    const body = FsChangesResponseSchema.parse(out.payload);
    assert.deepEqual(calls.find((x) => x.fn === "changedFiles")?.args, ["/repo"]);
    assert.equal(body.baseSha, "short:HEAD");
    assert.equal(body.headSha, null);
    assert.equal(body.baseLabel, null);
    assert.equal(body.headLabel, "feat");
    assert.equal(body.repoLabel, "eos");
    assert.equal(body.insertions, 2);
    assert.equal(body.files[0].patch, undefined); // no ?patches=1
  });

  it("detached HEAD: headLabel falls back to the short HEAD sha", async () => {
    const { c } = fakeContainer({ head: null });
    const body = FsChangesResponseSchema.parse((await get(c, "/fs/changes?cwd=/repo")).payload);
    assert.equal(body.headLabel, "short:HEAD");
  });

  it("repoLabel is null when toplevel resolution fails", async () => {
    const { c } = fakeContainer({ toplevel: null });
    const body = FsChangesResponseSchema.parse((await get(c, "/fs/changes?cwd=/repo")).payload);
    assert.equal(body.repoLabel, null);
  });

  it("?patches=1 embeds per-file patches split from one fullDiff vs HEAD", async () => {
    const { c, calls } = fakeContainer();
    const body = FsChangesResponseSchema.parse((await get(c, "/fs/changes?cwd=/repo&patches=1")).payload);
    assert.deepEqual(calls.find((x) => x.fn === "fullDiff")?.args, ["/repo"]);
    assert.match(body.files[0].patch ?? "", /\+alpha changed/);
    assert.match(body.files[1].patch ?? "", /\+bravo changed/);
    assert.doesNotMatch(body.files[0].patch ?? "", /bravo/);
  });
});

describe("GET /fs/changes?sha= (commit scope)", () => {
  it("maps commit files to ChangedFile and labels both sides", async () => {
    const { c, calls } = fakeContainer();
    const body = FsChangesResponseSchema.parse((await get(c, "/fs/changes?cwd=/repo&sha=abc1234")).payload);
    assert.deepEqual(calls.find((x) => x.fn === "commitDetail")?.args, ["/repo", "abc1234"]);
    assert.deepEqual(calls.find((x) => x.fn === "revParse")?.args, ["/repo", "abc1234^"]);
    assert.equal(calls.find((x) => x.fn === "changedFiles"), undefined);
    assert.ok(body.files.every((f) => f.untracked === false));
    assert.equal(body.baseSha, "short:abc1234^");
    assert.equal(body.headSha, "abc1234");
    assert.equal(body.baseLabel, null);
    assert.equal(body.headLabel, "abc1234");
    assert.equal(body.repoLabel, "eos");
    assert.equal(body.insertions, 2);
  });

  it("?patches=1 embeds patches from commitPatch", async () => {
    const { c, calls } = fakeContainer();
    const body = FsChangesResponseSchema.parse((await get(c, "/fs/changes?cwd=/repo&sha=abc1234&patches=1")).payload);
    assert.deepEqual(calls.find((x) => x.fn === "commitPatch")?.args, ["/repo", "abc1234"]);
    assert.match(body.files[0].patch ?? "", /\+alpha changed/);
    assert.match(body.files[1].patch ?? "", /\+bravo changed/);
  });

  it("unknown commit → 404", async () => {
    const { c } = fakeContainer({ detail: null });
    assert.equal((await get(c, "/fs/changes?cwd=/repo&sha=abcd9999")).status, 404);
  });

  it("non-hex sha → ValidationError (mapped to 400 by the error handler)", async () => {
    const { c } = fakeContainer();
    await assert.rejects(get(c, "/fs/changes?cwd=/repo&sha=main"), ValidationError);
  });
});

describe("GET /fs/changes/file", () => {
  it("without sha: same local-changes scope — fileDiff with no base ref", async () => {
    const { c, calls } = fakeContainer();
    const out = await get(c, "/fs/changes/file?cwd=/repo&path=a.txt");
    assert.equal(out.status, 200);
    assert.deepEqual(calls.find((x) => x.fn === "fileDiff")?.args, ["/repo", "a.txt", undefined]);
    assert.equal(out.payload.path, "a.txt");
  });

  it("with sha: calls commitFileDiff (oldPath forwarded)", async () => {
    const { c, calls } = fakeContainer();
    const out = await get(c, "/fs/changes/file?cwd=/repo&path=new.txt&oldPath=old.txt&sha=abcd12");
    assert.deepEqual(calls.find((x) => x.fn === "commitFileDiff")?.args, ["/repo", "abcd12", "new.txt", "old.txt"]);
    assert.equal(calls.find((x) => x.fn === "fileDiff"), undefined);
    assert.equal(out.payload.patch, "cp");
  });
});

describe("GET /fs/blob", () => {
  it("serves raw bytes with mime + immutable caching", async () => {
    const { c, calls } = fakeContainer({ blobSize: 4, blob: new Uint8Array([137, 80, 78, 71]) });
    const out = await get(c, "/fs/blob?cwd=/repo&ref=abcd1234&path=img/logo.png");
    assert.equal(out.status, 200);
    assert.equal(out.headers["content-type"], "image/png");
    assert.equal(out.headers["cache-control"], "public, max-age=86400, immutable");
    assert.deepEqual([...(out.payload as Uint8Array)], [137, 80, 78, 71]);
    assert.deepEqual(calls.find((x) => x.fn === "blobAtRef")?.args, ["/repo", "abcd1234", "img/logo.png"]);
  });

  it("unknown extension falls back to octet-stream", async () => {
    const { c } = fakeContainer();
    const out = await get(c, "/fs/blob?cwd=/repo&ref=abcd1234&path=some.dat");
    assert.equal(out.headers["content-type"], "application/octet-stream");
  });

  it("non-hex ref → ValidationError (mapped to 400)", async () => {
    const { c } = fakeContainer();
    await assert.rejects(get(c, "/fs/blob?cwd=/repo&ref=main&path=a.png"), ValidationError);
  });

  it("traversal and absolute paths → 400", async () => {
    const { c } = fakeContainer();
    assert.equal((await get(c, "/fs/blob?cwd=/repo&ref=abcd1234&path=../../etc/passwd")).status, 400);
    assert.equal((await get(c, "/fs/blob?cwd=/repo&ref=abcd1234&path=/etc/passwd")).status, 400);
  });

  it("oversize blob → 413 before reading bytes", async () => {
    const { c, calls } = fakeContainer({ blobSize: 21 * 1024 * 1024 });
    assert.equal((await get(c, "/fs/blob?cwd=/repo&ref=abcd1234&path=huge.bin")).status, 413);
    assert.equal(calls.find((x) => x.fn === "blobAtRef"), undefined);
  });

  it("missing blob → 404", async () => {
    const { c } = fakeContainer({ blobSize: null, blob: null });
    assert.equal((await get(c, "/fs/blob?cwd=/repo&ref=abcd1234&path=gone.png")).status, 404);
  });
});
