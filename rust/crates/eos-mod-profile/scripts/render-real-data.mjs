// What the TypeScript renders for a real data folder's profile and memories,
// for the Rust test to compare with (never commit the output: it is private).
//
//   node rust/crates/eos-mod-profile/scripts/render-real-data.mjs <copy of a data folder>
//
// Writes <folder>/render-expected.json; `EOS_REAL_HOME=<folder> cargo test -p eos-mod-profile`
// then checks the Rust renderer against it.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const home = process.argv[2];
if (!home) throw new Error("usage: render-real-data.mjs <data folder>");
const { renderUserProfile } = await import(join(REPO, "core/src/services/render-user-profile.ts"));
const { parseUserMemory } = await import(join(REPO, "infra/src/persistence/FileUserMemoryStore.ts"));
const { UserProfileSchema } = await import(join(REPO, "contracts/src/profile.ts"));

const profile = UserProfileSchema.parse(JSON.parse(readFileSync(join(home, "profile/profile.json"), "utf8")));
const dir = join(home, "profile/memories");
const memories = readdirSync(dir).filter((f) => f.endsWith(".md")).sort()
  .map((f) => parseUserMemory(readFileSync(join(dir, f), "utf8"))).filter(Boolean);
const projects = [null, ...new Set(memories.filter((m) => m.scope.kind === "project").map((m) => m.scope.path))];
const cases = [];
for (const project of projects) {
  for (const budgetTokens of [profile.budgetTokens, 200, 4000]) {
    for (const searchToolName of ["search_memory", null]) {
      const opts = { project, knownLines: [], searchToolName };
      cases.push({ project, budgetTokens, searchToolName, out: renderUserProfile({ ...profile, budgetTokens }, memories, opts) });
    }
  }
}
writeFileSync(join(home, "render-expected.json"), JSON.stringify({ cases }));
console.log(`${cases.length} renders of ${memories.length} memories`);
