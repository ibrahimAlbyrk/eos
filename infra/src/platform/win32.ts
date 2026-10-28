// Windows.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createWindowsFsHelpers } from "../filesystem/WindowsFsHelpers.ts";
import { fileClaudeStore } from "./claude-file-store.ts";
import { controlSocketPath } from "./control-socket.ts";
import { runEosHelper, startEosHelper } from "./eos-helper.ts";
import { gitBash, win32Shell } from "./win32-shell.ts";
import type { HostPlatform } from "./HostPlatform.ts";

// Provider API keys, each sealed with DPAPI for this Windows user (only this
// account on this computer can open them), one file per service under ~/.eos.
function secretFile(service: string): string {
  const home = process.env.EOS_HOME?.trim() || join(homedir(), ".eos");
  return join(home, "secrets", `${createHash("sha256").update(service).digest("hex").slice(0, 32)}.dpapi`);
}

export const win32Platform: HostPlatform = {
  os: "win32",
  // A pipe has no file mode, so access rests on its default DACL (only this
  // user may write) — docs/windows/00-WINDOWS-PLAN.md, Control plane.
  controlSocket: (home) => controlSocketPath(home, "pipe"),
  features: {
    // The first Windows release runs on one computer: no pairing yet.
    remote: false,
    get posixShell() { return gitBash() !== null; },
  },
  // The hostname is the name Windows shows for this PC.
  friendlyComputerName: () => null,
  fdCeiling: () => null,
  // ReadDirectoryChangesW watches a whole tree with one handle.
  nativeRecursiveWatch: true,

  credentials: {
    ...fileClaudeStore,
    readSecret(service) {
      try {
        return runEosHelper(["unprotect"], readFileSync(secretFile(service), "utf8")) || null;
      } catch {
        return null;
      }
    },
    // The secret reaches the helper on stdin, never argv.
    writeSecret(service, secret) {
      const file = secretFile(service);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, runEosHelper(["protect"], secret), { mode: 0o600 });
    },
  },

  async trash(path) {
    runEosHelper(["trash", path]);
  },

  // ES_SYSTEM_REQUIRED, held by the helper until it's killed or `pid` exits.
  keepAwake({ pid, log }) {
    const child = startEosHelper(["keep-awake", String(pid)]);
    if (!child) return null;
    child.on("error", (e) => log?.("keep-awake failed to start", { error: e.message }));
    child.unref();
    log?.("keep-awake on (system sleep held)", { pid: child.pid });
    return () => { child.kill(); };
  },

  createFsHelpers: () => createWindowsFsHelpers(),

  shell: win32Shell,

  scriptShell: gitBash,

  // No process groups: taskkill walks the tree.
  killProcessTree(pid) {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  },
};
