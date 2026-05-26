import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { BranchesQuerySchema } from "../../contracts/src/http.ts";
import { isSafeAbsPath } from "./fs-shared.ts";

export function registerFsGitRoutes(r: Router, c: Container): void {
  r.get("/fs/branches", async ({ url, res }) => {
    const q = validate(BranchesQuerySchema, {
      cwd: url.searchParams.get("cwd") ?? undefined,
    });
    if (!isSafeAbsPath(q.cwd)) { writeJson(res, 400, { error: "cwd must be absolute" }); return; }
    const [branches, current, remoteUrl] = await Promise.all([
      c.git.listBranches(q.cwd),
      c.git.currentBranch(q.cwd),
      c.git.remoteUrl(q.cwd),
    ]);
    const isGit = branches.length > 0 || current !== null;
    writeJson(res, 200, { branches, current, isGit, remoteUrl });
  });

  r.post("/fs/checkout", async ({ req, res }) => {
    const body = await readBody(req) as { cwd?: string; branch?: string };
    if (!isSafeAbsPath(body.cwd)) { writeJson(res, 400, { error: "cwd must be absolute" }); return; }
    if (typeof body.branch !== "string") { writeJson(res, 400, { error: "branch required" }); return; }
    try {
      await c.git.checkout(body.cwd, body.branch);
      writeJson(res, 200, { ok: true });
    } catch (e) {
      writeJson(res, 400, { error: (e as Error).message });
    }
  });

  r.get("/fs/recents", ({ res }) => {
    writeJson(res, 200, { paths: c.recents.list() });
  });
}
