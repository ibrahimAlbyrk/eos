// Assembles the shippable Resources/daemon tree next to the esbuild bundles:
// a real node_modules holding the 4 externals kept out of the bundles (their
// transitive closure is trivial — see below), then rebuilds node-pty for
// Electron's module ABI. Forge's extraResource copies the whole dir into
// Contents/Resources/daemon, which is where the Stage-2 packaged-mode gating
// (EOS_BUNDLES_DIR) resolves everything at runtime.
//
// Run by forge.config.js prePackage AFTER bundle-daemon.mjs. Safe to run standalone.
import { rebuild } from "@electron/rebuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { cpSync, rmSync, existsSync, mkdirSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const daemonDir = join(repoRoot, "app", ".forge-build", "daemon");
const nmDir = join(daemonDir, "node_modules");

// Closure (verified): SDK deps {} + its darwin-arm64 binary sibling; node-pty
// needs node-addon-api/prebuild-install only at build/install time; tree-sitter
// packages are zero-dep. So a flat copy of these 5 dirs is the full runtime set.
const COPY = [
  { from: "manager/node_modules/@anthropic-ai/claude-agent-sdk", to: "@anthropic-ai/claude-agent-sdk" },
  { from: "manager/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64", to: "@anthropic-ai/claude-agent-sdk-darwin-arm64" },
  { from: "spawner/node_modules/@homebridge/node-pty-prebuilt-multiarch", to: "@homebridge/node-pty-prebuilt-multiarch" },
  { from: "infra/node_modules/web-tree-sitter", to: "web-tree-sitter" },
  { from: "infra/node_modules/@vscode/tree-sitter-wasm", to: "@vscode/tree-sitter-wasm" },
];

if (!existsSync(join(daemonDir, "daemon.bundle.mjs"))) {
  console.error("assemble-daemon: bundles missing — run bundle-daemon.mjs first");
  process.exit(1);
}

rmSync(nmDir, { recursive: true, force: true });
mkdirSync(nmDir, { recursive: true });
for (const { from, to } of COPY) {
  const src = join(repoRoot, from);
  if (!existsSync(src)) { console.error(`assemble-daemon: missing ${from}`); process.exit(1); }
  const dest = join(nmDir, to);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, dereference: true });
}

// Prune node-pty's Linux prebuilds — dead weight on macOS.
const ptyPrebuilds = join(nmDir, "@homebridge/node-pty-prebuilt-multiarch/prebuilds");
if (existsSync(ptyPrebuilds)) {
  for (const d of readdirSync(ptyPrebuilds)) {
    if (d.startsWith("linux")) rmSync(join(ptyPrebuilds, d), { recursive: true, force: true });
  }
}

// @electron/rebuild reads a package.json at buildPath to locate deps. The shipped
// daemon dir has none (it's bundles + node_modules), so write a minimal manifest.
writeFileSync(join(daemonDir, "package.json"), JSON.stringify({
  name: "eos-daemon-bundle",
  version: "0.0.0",
  private: true,
  dependencies: { "@homebridge/node-pty-prebuilt-multiarch": "*" },
}, null, 2));

const electronVersion = JSON.parse(
  execSync("cat " + JSON.stringify(join(repoRoot, "app/node_modules/electron/package.json")), { encoding: "utf8" }),
).version;

// Rebuild node-pty for Electron's ABI (reproducible across machines). Best-effort:
// the prebuilt already dlopens under Electron-node here, so a failure is a
// reproducibility gap, not a hard blocker — reported either way.
let rebuildStatus = "ok";
try {
  await rebuild({
    buildPath: daemonDir,
    electronVersion,
    arch: "arm64",
    onlyModules: ["@homebridge/node-pty-prebuilt-multiarch"],
    force: true,
  });
} catch (e) {
  rebuildStatus = `FAILED: ${e instanceof Error ? e.message : String(e)}`;
}

const du = (p) => { try { return execSync(`du -sh ${JSON.stringify(p)}`, { encoding: "utf8" }).split("\t")[0]; } catch { return "?"; } };
const ptyNode = join(nmDir, "@homebridge/node-pty-prebuilt-multiarch/build/Release/pty.node");
console.log(
  `\nassembled -> ${nmDir}\n` +
    `  node_modules total: ${du(nmDir)}\n` +
    `  claude binary: ${du(join(nmDir, "@anthropic-ai/claude-agent-sdk-darwin-arm64"))}\n` +
    `  pty.node present: ${existsSync(ptyNode) ? statSync(ptyNode).size + " bytes" : "MISSING"}\n` +
    `  electron-rebuild (v${electronVersion}, arm64, node-pty): ${rebuildStatus}`,
);
if (rebuildStatus !== "ok") process.exitCode = 0; // non-fatal; reported above
