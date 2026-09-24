import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { ProjectUpsertRequestSchema, ProjectDeleteRequestSchema } from "../../contracts/src/http.ts";
import { isSafeAbsPath, uiTokenOk } from "./fs-shared.ts";

// Projects widen what an agent may touch (extra folders become SDK
// additionalDirectories), so mutations are UI-token gated like other fs writes.
export function registerProjectRoutes(r: Router, c: Container): void {
  r.get("/projects", ({ res }) => {
    writeJson(res, 200, { projects: c.projects.list() });
  });

  r.put("/projects", async ({ req, res }) => {
    const body = validate(ProjectUpsertRequestSchema, await readBody(req));
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return; }
    if (!body.folders.every(isSafeAbsPath)) { writeJson(res, 400, { error: "folders must be absolute" }); return; }
    const project = c.projects.upsert(body);
    for (const f of project.folders) c.recents.push(f);
    // Re-push the primary last so it tops the recents list.
    c.recents.push(project.folders[0]!);
    writeJson(res, 200, { project });
  });

  // Forgets the project and its folders from recents; agents are untouched.
  r.post("/projects/delete", async ({ req, res }) => {
    const body = validate(ProjectDeleteRequestSchema, await readBody(req));
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const removed = c.projects.remove(body.id);
    if (!removed) { writeJson(res, 404, { error: "project not found" }); return; }
    for (const f of removed.folders) c.recents.remove(f);
    writeJson(res, 200, { ok: true });
  });
}
