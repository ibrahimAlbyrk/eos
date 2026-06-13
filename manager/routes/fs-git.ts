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
} from "../../contracts/src/http.ts";
import { isSafeAbsPath, uiTokenOk } from "./fs-shared.ts";
import { createBranch } from "../../core/src/use-cases/CreateBranch.ts";
import { renameBranch } from "../../core/src/use-cases/RenameBranch.ts";
import { checkoutBranch } from "../../core/src/use-cases/CheckoutBranch.ts";

export function registerFsGitRoutes(r: Router, c: Container): void {
  // Mutating git routes operate on an arbitrary cwd, so they require both a safe
  // absolute path and the UI token — an agent holding EOS_DAEMON_URL must not be
  // able to mutate the user's repo through the daemon API.
  const guardMutation = (
    req: { headers: Record<string, string | string[] | undefined> },
    res: Parameters<typeof writeJson>[0],
    cwd: unknown,
  ): boolean => {
    if (!isSafeAbsPath(cwd)) { writeJson(res, 400, { error: "cwd must be absolute" }); return false; }
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return false; }
    return true;
  };

  r.get("/fs/branches", async ({ url, res }) => {
    const q = validate(BranchesQuerySchema, {
      cwd: url.searchParams.get("cwd") ?? undefined,
    });
    if (!isSafeAbsPath(q.cwd)) { writeJson(res, 400, { error: "cwd must be absolute" }); return; }
    // ?remotes=1 (the branch picker) additionally lists remote-tracking branches
    // + remote names; the status row omits it to keep the hot path cheap.
    const wantRemotes = url.searchParams.get("remotes") === "1";
    const [isGit, branches, current, remoteUrl, sync, stash, conflicts, remoteBranches, remotes] = await Promise.all([
      c.git.isRepo(q.cwd),
      c.git.listBranches(q.cwd),
      c.git.currentBranch(q.cwd),
      c.git.remoteUrl(q.cwd),
      c.git.syncStatus(q.cwd),
      c.git.stashCount(q.cwd),
      c.git.conflictCount(q.cwd),
      wantRemotes ? c.git.remoteBranches(q.cwd) : Promise.resolve(undefined),
      wantRemotes ? c.git.remotes(q.cwd) : Promise.resolve(undefined),
    ]);
    writeJson(res, 200, {
      branches, current, isGit, remoteUrl,
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

  // Checkout resolves a remote-tracking label (origin/x) to a local tracking
  // branch via the CheckoutBranch use-case, optionally stashing first, and is
  // UI-token gated. Returns a structured { ok, dirty?, error? } (like /push) so
  // the UI can offer "Stash & switch" instead of a raw git error dump.
  r.post("/fs/checkout", async ({ req, res }) => {
    const body = validate(FsCheckoutRequestSchema, await readBody(req));
    if (!guardMutation(req, res, body.cwd)) return;
    writeJson(res, 200, await checkoutBranch({ git: c.git }, body.cwd, body.branch, { stash: body.stash }));
  });

  // ---- Branch admin + remote sync (UI-token gated) --------------------------
  // Each returns 200 with an { ok, ... } body even on a git-level failure (same
  // convention as POST /push) so the UI can render the error/notMerged inline.

  r.post("/fs/branch/create", async ({ req, res }) => {
    const body = validate(BranchCreateRequestSchema, await readBody(req));
    if (!guardMutation(req, res, body.cwd)) return;
    writeJson(res, 200, await createBranch({ branchAdmin: c.branchAdmin }, body.cwd, body));
  });

  r.post("/fs/branch/rename", async ({ req, res }) => {
    const body = validate(BranchRenameRequestSchema, await readBody(req));
    if (!guardMutation(req, res, body.cwd)) return;
    writeJson(res, 200, await renameBranch({ branchAdmin: c.branchAdmin }, body.cwd, body));
  });

  r.post("/fs/branch/delete", async ({ req, res }) => {
    const body = validate(BranchDeleteRequestSchema, await readBody(req));
    if (!guardMutation(req, res, body.cwd)) return;
    writeJson(res, 200, await c.branchAdmin.remove(body.cwd, body.name, { force: body.force ?? false }));
  });

  r.post("/fs/fetch", async ({ req, res }) => {
    const body = validate(FetchRequestSchema, await readBody(req));
    if (!guardMutation(req, res, body.cwd)) return;
    writeJson(res, 200, await c.remoteSync.fetch(body.cwd, { prune: body.prune ?? true }));
  });

  r.post("/fs/remote-branch/delete", async ({ req, res }) => {
    const body = validate(RemoteBranchDeleteRequestSchema, await readBody(req));
    if (!guardMutation(req, res, body.cwd)) return;
    writeJson(res, 200, await c.remoteSync.deleteRemoteBranch(body.cwd, body.remote, body.branch));
  });

  r.get("/fs/recents", ({ res }) => {
    writeJson(res, 200, { paths: c.recents.list() });
  });
}
