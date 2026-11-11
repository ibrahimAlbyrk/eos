// Runs today's plugin builder (infra/src/plugins/EsbuildPluginBuilder.ts) over
// the sample plugins and records what it answers, for the Rust builder to equal:
//
//   node --no-warnings --experimental-strip-types rust/tools/plugin-vectors/build.mts
//
// Needs `npm ci` in contracts/ and infra/. Writes
// rust/crates/eos-plugin-build/tests/samples/expected.json.

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { version } from "../../../infra/node_modules/esbuild/lib/main.js";
import { EsbuildPluginBuilder } from "../../../infra/src/plugins/EsbuildPluginBuilder.ts";
import { parsePluginManifest, pluginUiEntry } from "../../../core/src/services/PluginService.ts";

const samples = resolve(dirname(fileURLToPath(import.meta.url)), "../../crates/eos-plugin-build/tests/samples");
const builder = new EsbuildPluginBuilder();
const out: Record<string, unknown> = {};

for (const name of readdirSync(samples).sort()) {
  const dir = join(samples, name);
  if (!statSync(dir).isDirectory()) continue;
  const manifest = parsePluginManifest(readFileSync(join(dir, "plugin.json"), "utf8"));
  if (typeof manifest === "string") throw new Error(`${name}: ${manifest}`);
  const entry = pluginUiEntry(manifest, readdirSync(dir));
  if (!entry) throw new Error(`${name}: no UI entry`);
  try {
    out[name] = { entry, ...(await builder.build(dir, entry)) };
  } catch (e) {
    out[name] = { entry, error: e instanceof Error ? e.message : String(e) };
  }
}

writeFileSync(join(samples, "expected.json"), JSON.stringify({ esbuild: version, samples: out }, null, 2) + "\n");
console.log(`${Object.keys(out).length} samples, esbuild ${version}`);
process.exit(0);
