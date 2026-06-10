// Single source of truth for what each build artifact depends on. The daemon
// imports backendSpec (via backend-stamp.ts) at boot to self-stamp, so the
// CLI and the running daemon always agree on the input set.
//
// Deliberate exclusions from the backend set (changing them converges
// WITHOUT a daemon restart, so restarting would kill agents for nothing):
//   - scripts/hooks/*.sh    — exec'd fresh by Claude on every tool call
//   - **/*.md               — prompts are re-read from disk per call/spawn
//   - manager/cli, bin      — the CLI runs from source on every invocation
//   - tsconfig*             — strip-types never reads them
//   - __tests__, *.test.*   — never loaded by the daemon
// Known gap: EOS_* env-var overrides affect effective config but not the
// stamp — only ~/.eos/config.json content is hashed.

import { join } from "node:path";

import type { ExcludeFn, StampSpec } from "./hash.ts";

export const DEPS_DIRS = [
  "contracts",
  "core",
  "infra",
  "gateway",
  "spawner",
  "manager",
  "manager/web",
  ".",
] as const;

const IGNORED_SEGMENTS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "__tests__",
  ".DS_Store",
]);

export const baseExclude: ExcludeFn = (rel) => {
  const segments = rel.split("/");
  if (segments.some((s) => IGNORED_SEGMENTS.has(s))) return true;
  const name = segments[segments.length - 1];
  return /\.test\.[^.]+$/.test(name) || name.endsWith(".md") || /^tsconfig[^/]*\.json$/.test(name);
};

const MANAGER_EXCLUDED_DIRS = new Set(["web", "vendor", "cli", "bin", "scripts"]);

export const managerExclude: ExcludeFn = (rel) => {
  if (MANAGER_EXCLUDED_DIRS.has(rel.split("/")[0])) return true;
  return baseExclude(rel);
};

export function depsSpec(repoRoot: string, dir: string): StampSpec {
  const pkgDir = join(repoRoot, dir);
  return {
    files: [
      { path: join(pkgDir, "package.json"), label: `${dir}/package.json` },
      { path: join(pkgDir, "package-lock.json"), label: `${dir}/package-lock.json` },
    ],
    extra: { node: process.version },
  };
}

export function webSpec(repoRoot: string): StampSpec {
  const webRoot = join(repoRoot, "manager", "web");
  return {
    trees: [
      { root: join(webRoot, "src"), prefix: "src", exclude: baseExclude },
      { root: join(webRoot, "public"), prefix: "public", exclude: baseExclude },
    ],
    files: ["index.html", "vite.config.js", "package.json", "package-lock.json"].map((f) => ({
      path: join(webRoot, f),
      label: f,
    })),
    extra: { node: process.version },
  };
}

export function appSpec(repoRoot: string): StampSpec {
  return {
    files: [
      { path: join(repoRoot, "app", "main.swift"), label: "app/main.swift" },
      { path: join(repoRoot, "app", "Info.plist"), label: "app/Info.plist" },
      { path: join(repoRoot, "app", "build.sh"), label: "app/build.sh" },
      // Icon source — build.sh regenerates the .icns from it.
      { path: join(repoRoot, "manager", "web", "public", "logo.png"), label: "logo.png" },
    ],
  };
}

export function backendSpec(repoRoot: string, configJsonPath: string): StampSpec {
  return {
    trees: [
      { root: join(repoRoot, "contracts"), prefix: "contracts", exclude: baseExclude },
      { root: join(repoRoot, "core"), prefix: "core", exclude: baseExclude },
      { root: join(repoRoot, "infra"), prefix: "infra", exclude: baseExclude },
      { root: join(repoRoot, "gateway"), prefix: "gateway", exclude: baseExclude },
      { root: join(repoRoot, "spawner"), prefix: "spawner", exclude: baseExclude },
      { root: join(repoRoot, "manager"), prefix: "manager", exclude: managerExclude },
    ],
    files: [{ path: configJsonPath, label: "eos-config.json" }],
    extra: { node: process.version },
  };
}
