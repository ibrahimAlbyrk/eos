#!/usr/bin/env node
// Thin CLI dispatcher. Every command lives in cli/commands/<name>.ts as a
// Command implementation; registry.ts collects them and exposes name +
// alias lookup. Adding a new verb means writing a new file and adding it
// to the registry — never editing this dispatcher.

import { join } from "node:path";

import { daemonFetch } from "./shared/http.ts";
import { loadConfig } from "./shared/config.ts";

import { findCommand } from "./cli/commands/registry.ts";

const CONFIG = loadConfig();
// CLAUDE_MGR_URL is kept as a separate override so callers can point the CLI
// at a non-default daemon without writing a full config.json.
const DAEMON_URL = process.env.CLAUDE_MGR_URL ?? `http://${CONFIG.daemon.host}:${CONFIG.daemon.port}`;
const LOG_DIR = CONFIG.daemon.logDir;
const REPO_ROOT = CONFIG.paths.repoRoot;

// CLI-flavored daemon fetch — exits process on transport/HTTP failures.
// The library-style throwing variant lives in shared/http.ts as daemonApi().
async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const r = await daemonFetch(DAEMON_URL, method, path, body);
  if (r.networkError) {
    console.error(`error: cannot reach daemon at ${DAEMON_URL} (${r.networkError.message})`);
    console.error(`hint: start daemon with: node --experimental-strip-types ${join(REPO_ROOT, "manager", "daemon.ts")}`);
    process.exit(1);
  }
  if (!r.ok) {
    console.error(`error ${r.status}: ${r.raw}`);
    process.exit(1);
  }
  return r.body;
}

const ctx = {
  daemonUrl: DAEMON_URL,
  repoRoot: REPO_ROOT,
  logDir: LOG_DIR,
  config: CONFIG,
  api,
};

const [, , cmd, ...rest] = process.argv;

if (cmd === undefined) {
  await findCommand("help")!.run([], ctx);
  process.exit(0);
}

const command = findCommand(cmd);
if (!command) {
  console.error(`unknown command: ${cmd}`);
  await findCommand("help")!.run([], ctx);
  process.exit(1);
}

await command.run(rest, ctx);
