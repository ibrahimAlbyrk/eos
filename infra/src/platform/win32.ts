// Windows.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createWindowsFsHelpers } from "../filesystem/WindowsFsHelpers.ts";
import { fileClaudeStore } from "./claude-file-store.ts";
import { controlSocketPath } from "./control-socket.ts";
import { runEosHelper, startEosHelper } from "./eos-helper.ts";
import { gitBash, win32Shell } from "./win32-shell.ts";
import { WinAppBundleCheck } from "../update/WinAppBundleCheck.ts";
import type { HostPlatform } from "./HostPlatform.ts";

// Provider API keys, each sealed with DPAPI for this Windows user (only this
// account on this computer can open them), one file per service under ~/.eos.
function secretFile(service: string): string {
  const home = process.env.EOS_HOME?.trim() || join(homedir(), ".eos");
  return join(home, "secrets", `${createHash("sha256").update(service).digest("hex").slice(0, 32)}.dpapi`);
}

function cmdQuote(arg: string): string {
  return /[\s"&|<>^()%!]/.test(arg) || arg === "" ? `"${arg.replace(/"/g, '""')}"` : arg;
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

  // A native build first; npm installs a CLI as a .cmd shim (next to a
  // Unix-shell script of the bare name, which Windows can't run).
  executableNames: (name) => [`${name}.exe`, `${name}.cmd`],

  spawnCommand(file, args) {
    if (!/\.(cmd|bat)$/i.test(file)) return { file, args };
    // Node refuses to spawn a .cmd without a shell; quoted as cmd /s /c reads it.
    const line = [file, ...args].map(cmdQuote).join(" ");
    return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
  },

  // No process groups: taskkill walks the tree.
  killProcessTree(pid) {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  },

  // Chrome where it's installed, else Edge, which every Windows 10/11 has.
  chromiumBrowsers: () => {
    const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter((r): r is string => Boolean(r));
    return [
      ...roots.map((r) => join(r, "Google", "Chrome", "Application", "chrome.exe")),
      ...roots.map((r) => join(r, "Microsoft", "Edge", "Application", "msedge.exe")),
    ];
  },

  appUpdates: {
    feedPlatform: process.arch === "arm64" ? "win32-arm64" : "win32-x64",
    // …\Programs\Eos\Eos.exe → …\Programs\Eos
    bundleRoot: (execPath) => (/^eos\.exe$/i.test(basename(execPath)) ? dirname(execPath) : null),
    bundleCheck: new WinAppBundleCheck(),
    fileModes: false,
  },
};
