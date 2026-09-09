// Packaged-app runtime resolution. In a packaged Electron app the daemon and
// every subprocess it spawns run off ELECTRON's own Node (process.execPath +
// ELECTRON_RUN_AS_NODE=1) against esbuild BUNDLES, instead of system node/bun
// against repo .ts sources. The Electron main sets EOS_PACKAGED=1 +
// EOS_BUNDLES_DIR when it spawns the daemon; those propagate to every child via
// the inherited env.
//
// All of this is a NO-OP in dev (EOS_PACKAGED unset): nodeBin() is "node",
// TypeScript runs via --experimental-strip-types, and entry paths point at the
// repo .ts — byte-identical to the pre-packaging behavior.

import { join } from "node:path";

export function isPackaged(): boolean {
  return process.env.EOS_PACKAGED === "1";
}

/** Directory holding the shipped *.bundle.mjs (packaged only). */
function bundlesDir(): string {
  return process.env.EOS_BUNDLES_DIR || "";
}

/**
 * The Node binary to spawn children with: Electron's own binary when packaged
 * (run as a plain Node via nodeRunEnv), else system "node" on PATH — unchanged.
 */
export function nodeBin(): string {
  return isPackaged() ? process.execPath : "node";
}

/** Env additions a child needs to run Electron's binary as a plain Node process. */
export function nodeRunEnv(): Record<string, string> {
  return isPackaged() ? { ELECTRON_RUN_AS_NODE: "1" } : {};
}

/** Flags for executing TypeScript directly — present in dev, dropped for bundles. */
export function tsRuntimeFlags(): string[] {
  return isPackaged() ? [] : ["--experimental-strip-types"];
}

/**
 * Resolve a subprocess entry: the shipped bundle when packaged, else the repo
 * .ts source. `devSegments` are joined onto repoRoot.
 */
function entry(bundleName: string, repoRoot: string, ...devSegments: string[]): string {
  return isPackaged() ? join(bundlesDir(), bundleName) : join(repoRoot, ...devSegments);
}

export const gatewayScriptPath = (repoRoot: string): string =>
  entry("gateway.bundle.mjs", repoRoot, "gateway", "server.ts");
export const workerMcpScriptPath = (repoRoot: string): string =>
  entry("worker-mcp.bundle.mjs", repoRoot, "manager", "worker-mcp.ts");
export const orchestratorMcpScriptPath = (repoRoot: string): string =>
  entry("orchestrator-mcp.bundle.mjs", repoRoot, "manager", "orchestrator-mcp.ts");
