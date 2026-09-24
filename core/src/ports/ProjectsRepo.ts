// ProjectsRepo — persistence port for user-defined projects (name, icon, source
// folders). Upsert without an id creates; the implementation mints the id.

import type { Project, ProjectUpsertRequest } from "../../../contracts/src/http.ts";

export interface ProjectsRepo {
  list(): Project[];
  upsert(input: ProjectUpsertRequest): Project;
  remove(id: string): Project | null;
}
