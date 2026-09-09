// Bundles the Eos daemon AND every separate-process entry it spawns
// (gateway, PTY worker, worker-mcp, orchestrator-mcp) into single ESM files the
// packaged app runs via Electron's own Node (process.execPath +
// ELECTRON_RUN_AS_NODE=1). Types are stripped at build time, so the shipped
// backend needs no --experimental-strip-types and no system node/bun.
//
// Externals stay OUT of every bundle and are shipped as real node_modules next
// to them, because each resolves an on-disk asset at RUNTIME that a relocated
// single file would break:
//   - @anthropic-ai/claude-agent-sdk  → require.resolve() of its platform `claude` binary
//   - web-tree-sitter / @vscode/tree-sitter-wasm → createRequire() of *.wasm grammars
//   - @homebridge/node-pty-prebuilt-multiarch → native .node (no esbuild loader)
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdirSync, statSync, writeFileSync } from "node:fs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const outDir = join(repoRoot, "app", ".forge-build", "daemon");

export const DAEMON_EXTERNALS = [
  "@homebridge/node-pty-prebuilt-multiarch",
  "@anthropic-ai/claude-agent-sdk",
  "web-tree-sitter",
  "@vscode/tree-sitter-wasm",
];

// entry source → output bundle name (all land in outDir together, so
// EOS_BUNDLES_DIR points at one directory).
const ENTRIES = [
  { entry: "manager/daemon.ts", out: "daemon.bundle.mjs" },
  { entry: "gateway/server.ts", out: "gateway.bundle.mjs" },
  { entry: "manager/worker-mcp.ts", out: "worker-mcp.bundle.mjs" },
  { entry: "manager/orchestrator-mcp.ts", out: "orchestrator-mcp.bundle.mjs" },
];

mkdirSync(outDir, { recursive: true });

let totalErrors = 0;
let totalWarnings = 0;
const report = [];

for (const { entry, out } of ENTRIES) {
  const outfile = join(outDir, out);
  const result = await build({
    entryPoints: [join(repoRoot, entry)],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24", // Electron 42 ships Node 24.x
    outfile,
    metafile: true,
    logLevel: "info",
    logLimit: 0,
    external: DAEMON_EXTERNALS,
    // Shim require/__dirname for any CJS dependency bundled into the ESM output.
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    absWorkingDir: repoRoot,
  });
  writeFileSync(join(outDir, `${out}.meta.json`), JSON.stringify(result.metafile));
  totalErrors += result.errors.length;
  totalWarnings += result.warnings.length;
  const mb = (statSync(outfile).size / (1024 * 1024)).toFixed(2);
  report.push(`  ${out.padEnd(28)} ${mb.padStart(6)} MB   err:${result.errors.length} warn:${result.warnings.length}`);
}

console.log(
  `\nbundled backend -> ${outDir}\n${report.join("\n")}\n` +
    `  totals: ${totalErrors} errors, ${totalWarnings} warnings\n` +
    `  externals (ship as node_modules): ${DAEMON_EXTERNALS.join(", ")}`,
);
if (totalErrors > 0) process.exit(1);
