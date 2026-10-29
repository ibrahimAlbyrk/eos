// Any system without its own adapter: the claude binary's file store, no system
// trash, sleep or secret store, no desktop integration.

import { noopFsHelpers } from "../filesystem/NoopFsHelpers.ts";
import { fileClaudeStore } from "./claude-file-store.ts";
import { controlSocketPath } from "./control-socket.ts";
import { posixShell } from "./posix-shell.ts";
import type { HostPlatform } from "./HostPlatform.ts";

export function genericPlatform(os: string): HostPlatform {
  return {
    os,
    controlSocket: (home) => controlSocketPath(home, "socket"),
    features: { remote: true, posixShell: true },
    friendlyComputerName: () => null,
    fdCeiling: () => null,
    nativeRecursiveWatch: false,
    credentials: {
      ...fileClaudeStore,
      readSecret: () => null,
      writeSecret() {
        throw new Error("Secret storage is not supported on this system");
      },
    },
    trash: null,
    keepAwake: () => null,
    createFsHelpers: () => noopFsHelpers,
    shell: posixShell,
    scriptShell: () => "/bin/sh",
    executableNames: (name) => [name],
    spawnCommand: (file, args) => ({ file, args }),
    killProcessTree: (pid) => { process.kill(-pid, "SIGKILL"); },
  };
}
