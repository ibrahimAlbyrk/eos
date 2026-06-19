// Worker-type catalog + runtime mint. GET lists every type visible to the
// owner orchestrator (built-in / user / project on disk + its own runtime
// mints); POST mints a runtime type for the owner (per-owner, in-memory).

import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { MintWorkerTypeRequestSchema } from "../../contracts/src/http.ts";
import type { WorkerTypeRecord } from "../../contracts/src/worker-type.ts";

export function registerWorkerTypeRoutes(r: Router, c: Container): void {
  r.get("/worker-types", ({ url, res }) => {
    const owner = url.searchParams.get("owner");
    const ownerRow = owner ? c.workers.findById(owner) : null;
    const cwd = ownerRow?.worktree_dir ?? ownerRow?.cwd ?? null;
    // Disk first, runtime last → runtime wins on a name clash (same precedence
    // as the spawn path). Dedup by name into lean catalog entries.
    const byName = new Map<string, WorkerTypeRecord>();
    for (const rec of c.listWorkerTypeRecords(cwd)) byName.set(rec.name, rec);
    if (owner) for (const rec of c.runtimeWorkerTypes.listFor(owner)) byName.set(rec.name, rec);
    const types = [...byName.values()].map((t) => ({
      name: t.name,
      description: t.description,
      whenToUse: t.whenToUse,
      source: t.source,
    }));
    writeJson(res, 200, types);
  });

  r.post("/worker-types", async ({ url, req, res }) => {
    const owner = url.searchParams.get("owner");
    if (!owner) {
      writeJson(res, 400, { error: "owner query param required" });
      return;
    }
    const parsed = validate(MintWorkerTypeRequestSchema, await readBody(req));
    c.runtimeWorkerTypes.mint(owner, parsed);
    writeJson(res, 201, { name: parsed.name });
  });
}
