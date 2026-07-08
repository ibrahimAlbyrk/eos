import { basename } from "node:path";
import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import {
  BranchesQuerySchema,
  FsCheckoutRequestSchema,
  BranchCreateRequestSchema,
  BranchRenameRequestSchema,
  BranchDeleteRequestSchema,
  FetchRequestSchema,
  RemoteBranchDeleteRequestSchema,
  FsLogQuerySchema,
  FsChangesQuerySchema,
  FsChangesFileQuerySchema,
  FsBlobQuerySchema,
  FsStashesQuerySchema,
  FsStashApplyRequestSchema,
  FsStashDropRequestSchema,
  type ChangedFile,
} from "../../contracts/src/http.ts";
import { guardMutation, isSafeAbsPath, repoRelative, IMAGE_MIME } from "./fs-shared.ts";
import { attachPatches, PATCH_MAX_BYTES, PATCHES_TOTAL_MAX_BYTES } from "../../infra/src/git/changes-parse.ts";
import { createBranch } from "../../core/src/use-cases/CreateBranch.ts";
import { renameBranch } from "../../core/src/use-cases/RenameBranch.ts";
import { checkoutBranch } from "../../core/src/use-cases/CheckoutBranch.ts";
import { orderBranches } from "../../core/src/domain/branch-order.ts";

// /fs/blob cap — matches the /fs/paste upload limit; anything bigger gets a
// 413 so the panel can degrade to a size note instead of streaming a huge file.
const BLOB_MAX_BYTES = 20 * 1024 * 1024;

export function registerFsGitRoutes(r: Router, c: Container): void {
  // Mutating git routes operate on an arbitrary cwd, so they require both a safe
  // absolute path and the UI token (guardMutation, shared with fs-mutate) — an
  // agent holding EOS_DAEMON_URL must not mutate the user's repo via the daemon.
  r.get("/fs/branches", async ({ url, res }) => {
    const q = validate(BranchesQuerySchema, {
      cwd: url.searchParams.get("cwd") ?? undefined,
    });
    if (!isSafeAbsPath(q.cwd)) { writeJson(res, 400, { error: "cwd must be absolute" }); return; }
    // ?remotes=1 (the branch picker) additionally lists remote-tracking branches
    // + remote names, and orders locals by checkout recency (reflog); the status
    // row omits all of it to keep the hot path cheap.
    const wantRemotes = url.searchParams.get("remotes") === "1";
    const [isGit, branches, current, remoteUrl, sync, stash, conflicts, remoteBranches, remotes, usage] = await Promise.all([
      c.git.isRepo(q.cwd),
      c.git.listBranches(q.cwd),
      c.git.currentBranch(q.cwd),
      c.git.remoteUrl(q.cwd),
      c.git.syncStatus(q.cwd),
      c.git.stashCount(q.cwd),
      c.git.conflictCount(q.cwd),
      wantRemotes ? c.git.remoteBranches(q.cwd) : Promise.resolve(undefined),
      wantRemotes ? c.git.remotes(q.cwd) : Promise.resolve(undefined),
      wantRemotes ? c.git.recentCheckouts(q.cwd) : Promise.resolve(undefined),
    ]);
    writeJson(res, 200, {
      branches: usage ? orderBranches(branches, usage, current) : branches,
      current, isGit, remoteUrl,
      ahead: sync?.ahead ?? null,
      behind: sync?.behind ?? null,
      stash,
      conflicts,
      ...(remoteBranches ? { remoteBranches } : {}),
      ...(remotes ? { remotes } : {}),
    });
  });

  r.get("/fs/unpushed", async ({ url, res }) => {
    const q = validate(BranchesQuerySchema, {
      cwd: url.searchParams.get("cwd") ?? undefined,
    });
    if (!isSafeAbsPath(q.cwd)) { writeJson(res, 400, { error: "cwd must be absolute" }); return; }
    writeJson(res, 200, { commits: await c.git.unpushedCommits(q.cwd) });
  });

  r.get("/fs/commit", async ({ url, res }) => {
    const q = validate(BranchesQuerySchema, {
      cwd: url.searchParams.get("cwd") ?? undefined,
    });
    const sha = url.searchParams.get("sha") ?? "";
    if (!isSafeAbsPath(q.cwd)) { writeJson(res, 400, { error: "cwd must be absolute" }); return; }
    if (!/^[0-9a-f]{4,40}$/i.test(sha)) { writeJson(res, 400, { error: "valid sha required" }); return; }
    const detail = await c.git.commitDetail(q.cwd, sha);
    if (!detail) { writeJson(res, 404, { error: "commit not found" }); return; }
    writeJson(res, 200, detail);
  });

  // ---- Git Diff panel reads --------------------------------------------------
  // Un-gated GETs like the other /fs reads: safe absolute cwd, no UI token.
  // Working-tree scope is LOCAL CHANGES ONLY: staged + unstaged + untracked vs
  // HEAD — committed work never appears (the log/commit views cover it).

  // Repo directory name for the panel header — null when cwd isn't a repo.
  const repoLabelOf = async (cwd: string): Promise<string | null> => {
    const dirs = await c.git.gitDirs(cwd);
    return dirs ? basename(dirs.toplevel) : null;
  };

  r.get("/fs/log", async ({ url, res }) => {
    const q = validate(FsLogQuerySchema, {
      cwd: url.searchParams.get("cwd") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      skip: url.searchParams.get("skip") ?? undefined,
    });
    if (!isSafeAbsPath(q.cwd)) { writeJson(res, 400, { error: "cwd must be absolute" }); return; }
    // log() fetches limit+1 rows — the overflow row only answers hasMore.
    const rows = await c.git.log(q.cwd, { limit: q.limit, skip: q.skip });
    writeJson(res, 200, { commits: rows.slice(0, q.limit), hasMore: rows.length > q.limit });
  });

  r.get("/fs/stashes", async ({ url, res }) => {
    const q = validate(FsStashesQuerySchema, {
      cwd: url.searchParams.get("cwd") ?? undefined,
    });
    if (!isSafeAbsPath(q.cwd)) { writeJson(res, 400, { error: "cwd must be absolute" }); return; }
    writeJson(res, 200, { stashes: await c.git.stashList(q.cwd) });
  });

  r.get("/fs/changes", async ({ url, res }) => {
    const q = validate(FsChangesQuerySchema, {
      cwd: url.searchParams.get("cwd") ?? undefined,
      sha: url.searchParams.get("sha") ?? undefined,
    });
    if (!isSafeAbsPath(q.cwd)) { writeJson(res, 400, { error: "cwd must be absolute" }); return; }
    const wantPatches = url.searchParams.get("patches") === "1";

    if (q.sha) {
      const detail = await c.git.commitDetail(q.cwd, q.sha);
      if (!detail) { writeJson(res, 404, { error: "commit not found" }); return; }
      const files: ChangedFile[] = detail.files.map((f) => ({ ...f, untracked: false }));
      const [full, baseSha, repoLabel] = await Promise.all([
        wantPatches ? c.git.commitPatch(q.cwd, q.sha) : Promise.resolve(null),
        // Null parent = root commit — the panel renders "everything added".
        c.git.revParse(q.cwd, `${q.sha}^`),
        repoLabelOf(q.cwd),
      ]);
      if (full !== null) attachPatches(files, full, PATCH_MAX_BYTES, PATCHES_TOTAL_MAX_BYTES);
      writeJson(res, 200, {
        files,
        insertions: detail.insertions,
        deletions: detail.deletions,
        baseSha,
        headSha: detail.sha,
        baseLabel: null,
        headLabel: detail.sha,
        repoLabel,
      });
      return;
    }

    const [files, full, baseSha, head, repoLabel] = await Promise.all([
      c.git.changedFiles(q.cwd),
      wantPatches ? c.git.fullDiff(q.cwd) : Promise.resolve(null),
      c.git.revParse(q.cwd, "HEAD"),
      c.git.currentBranch(q.cwd),
      repoLabelOf(q.cwd),
    ]);
    if (full !== null) attachPatches(files, full, PATCH_MAX_BYTES, PATCHES_TOTAL_MAX_BYTES);
    writeJson(res, 200, {
      files,
      insertions: files.reduce((n, f) => n + (f.insertions ?? 0), 0),
      deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
      baseSha,
      headSha: null, // working tree, not a commit
      baseLabel: null,
      // Detached HEAD has no branch name — fall back to the short HEAD sha.
      headLabel: head ?? baseSha ?? "HEAD",
      repoLabel,
    });
  });

  r.get("/fs/changes/file", async ({ url, res }) => {
    const q = validate(FsChangesFileQuerySchema, {
      cwd: url.searchParams.get("cwd") ?? undefined,
      path: url.searchParams.get("path") ?? undefined,
      oldPath: url.searchParams.get("oldPath") ?? undefined,
      sha: url.searchParams.get("sha") ?? undefined,
    });
    if (!isSafeAbsPath(q.cwd)) { writeJson(res, 400, { error: "cwd must be absolute" }); return; }
    if (q.sha) {
      writeJson(res, 200, await c.git.commitFileDiff(q.cwd, q.sha, q.path, q.oldPath));
      return;
    }
    // Same local-changes-only scope as /fs/changes: no base ref → diff vs HEAD.
    writeJson(res, 200, await c.git.fileDiff(q.cwd, q.path, q.oldPath));
  });

  r.get("/fs/blob", async ({ url, res }) => {
    const q = validate(FsBlobQuerySchema, {
      cwd: url.searchParams.get("cwd") ?? undefined,
      ref: url.searchParams.get("ref") ?? undefined,
      path: url.searchParams.get("path") ?? undefined,
    });
    if (!isSafeAbsPath(q.cwd)) { writeJson(res, 400, { error: "cwd must be absolute" }); return; }
    if (!repoRelative(q.path)) { writeJson(res, 400, { error: "path must be repo-relative" }); return; }
    const size = await c.git.blobSizeAtRef(q.cwd, q.ref, q.path);
    if (size !== null && size > BLOB_MAX_BYTES) {
      writeJson(res, 413, { error: `blob too large (${size} bytes, limit ${BLOB_MAX_BYTES})` });
      return;
    }
    const data = await c.git.blobAtRef(q.cwd, q.ref, q.path);
    if (data === null) { writeJson(res, 404, { error: "blob not found" }); return; }
    const ext = q.path.split(".").pop()?.toLowerCase() ?? "";
    res.writeHead(200, {
      "content-type": IMAGE_MIME[ext] ?? "application/octet-stream",
      // Hex-ref-addressed content never changes — safe to cache immutably.
      "cache-control": "public, max-age=86400, immutable",
    });
    res.end(data);
  });

  // Checkout resolves a remote-tracking label (origin/x) to a local tracking
  // branch via the CheckoutBranch use-case, optionally stashing first, and is
  // UI-token gated. Returns a structured { ok, dirty?, error? } (like /push) so
  // the UI can offer "Stash & switch" instead of a raw git error dump.
  r.post("/fs/checkout", async ({ req, res }) => {
    const body = validate(FsCheckoutRequestSchema, await readBody(req));
    if (!guardMutation(req, res, body.cwd, c.uiToken)) return;
    writeJson(res, 200, await checkoutBranch({ git: c.git }, body.cwd, body.branch, { stash: body.stash }));
  });

  // Stash apply/drop for the Git Diff panel's Stashes menu. UI-token gated like
  // the other mutations; both return { ok, error? } — apply reports a conflict
  // inline (never throws) so the UI can surface git's message.
  r.post("/fs/stash/apply", async ({ req, res }) => {
    const body = validate(FsStashApplyRequestSchema, await readBody(req));
    if (!guardMutation(req, res, body.cwd, c.uiToken)) return;
    writeJson(res, 200, await c.git.stashApply(body.cwd, body.index));
  });

  r.post("/fs/stash/drop", async ({ req, res }) => {
    const body = validate(FsStashDropRequestSchema, await readBody(req));
    if (!guardMutation(req, res, body.cwd, c.uiToken)) return;
    writeJson(res, 200, await c.git.stashDrop(body.cwd, body.index));
  });

  // ---- Branch admin + remote sync (UI-token gated) --------------------------
  // Each returns 200 with an { ok, ... } body even on a git-level failure (same
  // convention as POST /push) so the UI can render the error/notMerged inline.

  r.post("/fs/branch/create", async ({ req, res }) => {
    const body = validate(BranchCreateRequestSchema, await readBody(req));
    if (!guardMutation(req, res, body.cwd, c.uiToken)) return;
    writeJson(res, 200, await createBranch({ branchAdmin: c.branchAdmin }, body.cwd, body));
  });

  r.post("/fs/branch/rename", async ({ req, res }) => {
    const body = validate(BranchRenameRequestSchema, await readBody(req));
    if (!guardMutation(req, res, body.cwd, c.uiToken)) return;
    writeJson(res, 200, await renameBranch({ branchAdmin: c.branchAdmin }, body.cwd, body));
  });

  r.post("/fs/branch/delete", async ({ req, res }) => {
    const body = validate(BranchDeleteRequestSchema, await readBody(req));
    if (!guardMutation(req, res, body.cwd, c.uiToken)) return;
    writeJson(res, 200, await c.branchAdmin.remove(body.cwd, body.name, { force: body.force ?? false }));
  });

  r.post("/fs/fetch", async ({ req, res }) => {
    const body = validate(FetchRequestSchema, await readBody(req));
    if (!guardMutation(req, res, body.cwd, c.uiToken)) return;
    writeJson(res, 200, await c.remoteSync.fetch(body.cwd, { prune: body.prune ?? true }));
  });

  r.post("/fs/remote-branch/delete", async ({ req, res }) => {
    const body = validate(RemoteBranchDeleteRequestSchema, await readBody(req));
    if (!guardMutation(req, res, body.cwd, c.uiToken)) return;
    writeJson(res, 200, await c.remoteSync.deleteRemoteBranch(body.cwd, body.remote, body.branch));
  });

  r.get("/fs/recents", ({ res }) => {
    writeJson(res, 200, { paths: c.recents.list() });
  });
}
