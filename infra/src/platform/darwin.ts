// macOS.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createDarwinFsHelpers } from "../filesystem/DarwinFsHelpers.ts";
import { trashViaFinder } from "../filesystem/trashDarwin.ts";
import { startCaffeinate } from "./caffeinate.ts";
import { controlSocketPath } from "./control-socket.ts";
import { claudeStoreService, deleteKeychainItem, readKeychainItem, writeKeychainItem } from "./keychain.ts";
import { posixShell } from "./posix-shell.ts";
import type { HostPlatform } from "./HostPlatform.ts";

// <sys/syslimits.h> OPEN_MAX
const OPEN_MAX = 10240;

export const darwinPlatform: HostPlatform = {
  os: "darwin",
  controlSocket: (home) => controlSocketPath(home, "socket"),
  features: { remote: true, posixShell: true },

  // The name people see in Finder/Sharing ("Office iMac"), not the DNS hostname.
  friendlyComputerName() {
    try {
      return execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000 }).trim() || null;
    } catch {
      return null;
    }
  },

  // macOS caps actual open fds at kern.maxfilesperproc regardless of the (often
  // far larger) rlimit Node sets at startup, and posix_spawn rejects any fd
  // ≥ OPEN_MAX with EBADF — so past OPEN_MAX open fds the daemon can no longer
  // start a child, whatever the rlimit.
  fdCeiling() {
    try {
      const cap = Number(execFileSync("/usr/sbin/sysctl", ["-n", "kern.maxfilesperproc"], { encoding: "utf8" }).trim());
      return Number.isFinite(cap) && cap > 0 ? Math.min(cap, OPEN_MAX) : OPEN_MAX;
    } catch {
      return OPEN_MAX;
    }
  },

  // A recursive watch rides the shared FSEvents stream.
  nativeRecursiveWatch: true,

  credentials: {
    readClaudeStore: (storeDir) => readKeychainItem(claudeStoreService(storeDir)),
    clearClaudeStore: (storeDir) => deleteKeychainItem(claudeStoreService(storeDir)),
    readSecret: readKeychainItem,
    writeSecret: writeKeychainItem,
  },

  trash: trashViaFinder,

  keepAwake: (opts) => startCaffeinate(opts),

  createFsHelpers: ({ repoRoot, iconCacheDir }) => createDarwinFsHelpers({
    helperScript: join(repoRoot, "manager", "scripts", "macos-default-app.swift"),
    iconCacheDir,
  }),

  shell: posixShell,

  scriptShell: () => "/bin/sh",

  executableNames: (name) => [name],
  spawnCommand: (file, args) => ({ file, args }),

  killProcessTree: (pid) => { process.kill(-pid, "SIGKILL"); },
};
