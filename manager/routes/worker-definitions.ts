// Worker-definition catalog + runtime create. GET lists every definition visible to the
// owner orchestrator (built-in / user / project on disk + its own runtime
// creates); POST creates a runtime definition for the owner (per-owner, in-memory).

import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { CreateWorkerRequestSchema } from "../../contracts/src/http.ts";
import type { WorkerDefinitionRecord } from "../../contracts/src/worker-definition.ts";

export function registerWorkerDefinitionRoutes(r: Router, c: Container): void {
  r.get("/worker-definitions", ({ url, res }) => {
    const owner = url.searchParams.get("owner");
    const ownerRow = owner ? c.workers.findById(owner) : null;
    const cwd = ownerRow?.worktree_dir ?? ownerRow?.cwd ?? null;
    // Disk first, runtime last → runtime wins on a name clash (same precedence
    // as the spawn path). Dedup by name into lean catalog entries.
    const byName = new Map<string, WorkerDefinitionRecord>();
    for (const rec of c.listWorkerDefinitionRecords(cwd)) byName.set(rec.name, rec);
    if (owner) for (const rec of c.runtimeWorkerDefinitions.listFor(owner)) byName.set(rec.name, rec);
    const entries = [...byName.values()].map((t) => ({
      name: t.name,
      description: t.description,
      whenToUse: t.whenToUse,
      source: t.source,
    }));
    writeJson(res, 200, entries);
  });

  r.post("/worker-definitions", async ({ url, req, res }) => {
    const owner = url.searchParams.get("owner");
    if (!owner) {
      writeJson(res, 400, { error: "owner query param required" });
      return;
    }
    const parsed = validate(CreateWorkerRequestSchema, await readBody(req));
    c.runtimeWorkerDefinitions.create(owner, parsed);
    writeJson(res, 201, { name: parsed.name });
  });
}
