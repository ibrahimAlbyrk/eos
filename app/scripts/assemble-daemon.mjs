// Assembles the shippable Resources/daemon tree next to the esbuild bundles:
// a real node_modules holding the externals kept out of the bundles (their
// transitive closure is trivial — see below). node-pty's prebuilds are N-API,
// so the one for this system loads under Electron's Node as is. Forge's extraResource copies the whole dir into
// Contents/Resources/daemon, which is where the Stage-2 packaged-mode gating
// (EOS_BUNDLES_DIR) resolves everything at runtime.
//
// Run by forge.config.js prePackage AFTER bundle-daemon.mjs. Safe to run standalone.
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { cpSync, rmSync, existsSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const daemonDir = join(repoRoot, "app", ".forge-build", "daemon");
const nmDir = join(daemonDir, "node_modules");

// The tree is built on (and for) the machine packaging it: CI builds each
// system + arch on its own runner, since node-pty can't be cross-built.
const target = `${process.platform}-${process.arch}`;
const sdkBinary = `@anthropic-ai/claude-agent-sdk-${target}`;

// Closure (verified): SDK deps {} + its platform binary sibling; node-pty
// needs node-addon-api/prebuild-install only at build/install time; tree-sitter
// packages are zero-dep. So a flat copy of these 5 dirs is the full runtime set.
const COPY = [
  { from: "manager/node_modules/@anthropic-ai/claude-agent-sdk", to: "@anthropic-ai/claude-agent-sdk" },
  { from: `manager/node_modules/${sdkBinary}`, to: sdkBinary },
  { from: "spawner/node_modules/node-pty", to: "node-pty" },
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

// The symbol parser bundle reads its tags queries from ./grammars beside it.
cpSync(join(repoRoot, "infra", "src", "symbols", "grammars"), join(daemonDir, "grammars"), { recursive: true });

// Prune node-pty's prebuilds for other systems — dead weight in this build.
const ptyPrebuilds = join(nmDir, "node-pty", "prebuilds");
if (existsSync(ptyPrebuilds)) {
  for (const d of readdirSync(ptyPrebuilds)) {
    if (d !== target) rmSync(join(ptyPrebuilds, d), { recursive: true, force: true });
  }
}

const ptyBinary = join(nmDir, "node-pty", "prebuilds", target, process.platform === "win32" ? "conpty.node" : "pty.node");
const du = (p) => { try { return execSync(`du -sh ${JSON.stringify(p)}`, { encoding: "utf8" }).split("\t")[0]; } catch { return "?"; } };
console.log(
  `\nassembled -> ${nmDir}\n` +
    `  node_modules total: ${du(nmDir)}\n` +
    `  claude binary: ${du(join(nmDir, sdkBinary))}\n` +
    `  node-pty ${target}: ${existsSync(ptyBinary) ? statSync(ptyBinary).size + " bytes" : "MISSING"}`,
);
if (!existsSync(ptyBinary)) {
  console.error(`assemble-daemon: node-pty has no prebuild for ${target}`);
  process.exit(1);
}
