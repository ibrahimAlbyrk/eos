// JsonProjectsRepo — file-backed user projects (~/.eos/projects.json), in
// creation order. Same atomic tmp + rename write as JsonRecentsRepo.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { ProjectSchema, type Project, type ProjectUpsertRequest } from "../../../contracts/src/http.ts";
import type { ProjectsRepo } from "../../../core/src/ports/ProjectsRepo.ts";

export class JsonProjectsRepo implements ProjectsRepo {
  private readonly file: string;
  private cache: Project[];

  constructor(file: string) {
    this.file = file;
    this.cache = this.read();
  }

  list(): Project[] {
    return this.cache;
  }

  upsert(input: ProjectUpsertRequest): Project {
    const project: Project = { ...input, id: input.id ?? randomUUID(), folders: [...new Set(input.folders)] };
    const exists = this.cache.some((p) => p.id === project.id);
    this.cache = exists
      ? this.cache.map((p) => (p.id === project.id ? project : p))
      : [...this.cache, project];
    this.write();
    return project;
  }

  remove(id: string): Project | null {
    const removed = this.cache.find((p) => p.id === id) ?? null;
    if (!removed) return null;
    this.cache = this.cache.filter((p) => p.id !== id);
    this.write();
    return removed;
  }

  // Invalid entries are dropped rather than failing the whole file.
  private read(): Project[] {
    try {
      if (!existsSync(this.file)) return [];
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((p) => {
        const r = ProjectSchema.safeParse(p);
        return r.success ? [r.data] : [];
      });
    } catch {
      return [];
    }
  }

  private write(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.cache, null, 2));
    renameSync(tmp, this.file);
  }
}
