// Dumps the TypeScript runner's migrations as migrations/NNN_name.sql (the SQL
// byte for byte) plus index.json: [{ id, sha256 }] in run order.
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MIGRATIONS } from "../../../../infra/src/persistence/MigrationRunner.ts";

const out = process.argv[2];
if (!out) throw new Error("usage: export-migrations.ts <outDir>");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const index = MIGRATIONS.map((m) => {
  writeFileSync(join(out, `${m.id}.sql`), m.sql);
  return { id: m.id, sha256: createHash("sha256").update(m.sql).digest("hex") };
});
writeFileSync(join(out, "index.json"), JSON.stringify(index, null, 2) + "\n");
console.log(`${index.length} migrations`);
