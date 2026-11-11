// Dumps the TypeScript runner's migrations as migrations/<id>.sql (the SQL byte
// for byte) and the list the crate embeds them from, in run order.
//
//   node rust/crates/eos-kit-sqlite/scripts/export-migrations.ts
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MIGRATIONS } from "../../../../infra/src/persistence/MigrationRunner.ts";

const crate = join(import.meta.dirname, "..");
const out = join(crate, "migrations");
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) if (f.endsWith(".sql")) rmSync(join(out, f));
for (const m of MIGRATIONS) writeFileSync(join(out, `${m.id}.sql`), m.sql);

const list = [
  "// Written by scripts/export-migrations.ts from infra/src/persistence/MigrationRunner.ts.",
  "// Never edit, reorder or drop an entry: `schema_migrations` in every user's file records these ids.",
  "",
  "use super::Migration;",
  "",
  "pub(super) const EMBEDDED: &[Migration] = &[",
  ...MIGRATIONS.map((m) => `    embed!("${m.id}"),`),
  "];",
  "",
];
writeFileSync(join(crate, "src", "migrate", "embedded.rs"), list.join("\n"));
console.log(`${MIGRATIONS.length} migrations`);
