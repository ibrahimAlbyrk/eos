import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { BranchesQuerySchema } from "../../contracts/src/http.ts";
import { isSafeAbsPath } from "./fs-shared.ts";
import { errMsg } from "../../contracts/src/util.ts";

export function registerFsGitRoutes(r: Router, c: Container): void {
  r.get("/fs/branches", async ({ url, res }) => {
    const q = validate(BranchesQuerySchema, {
      cwd: url.searchParams.get("cwd") ?? undefined,
    });
    if (!isSafeAbsPath(q.cwd)) { writeJson(res, 400, { error: "cwd must be absolute" }); return; }
    const [isGit, branches, current, remoteUrl, sync, stash, conflicts] = await Promise.all([
      c.git.isRepo(q.cwd),
      c.git.listBranches(q.cwd),
      c.git.currentBranch(q.cwd),
      c.git.remoteUrl(q.cwd),
      c.git.syncStatus(q.cwd),
      c.git.stashCount(q.cwd),
      c.git.conflictCount(q.cwd),
    ]);
    writeJson(res, 200, {
      branches, current, isGit, remoteUrl,
      ahead: sync?.ahead ?? null,
      behind: sync?.behind ?? null,
      stash,
      conflicts,
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

  r.post("/fs/checkout", async ({ req, res }) => {
    const body = await readBody(req) as { cwd?: string; branch?: string };
    if (!isSafeAbsPath(body.cwd)) { writeJson(res, 400, { error: "cwd must be absolute" }); return; }
    if (typeof body.branch !== "string") { writeJson(res, 400, { error: "branch required" }); return; }
    try {
      await c.git.checkout(body.cwd, body.branch);
      writeJson(res, 200, { ok: true });
    } catch (e) {
      writeJson(res, 400, { error: errMsg(e) });
    }
  });

  r.get("/fs/recents", ({ res }) => {
    writeJson(res, 200, { paths: c.recents.list() });
  });
}
