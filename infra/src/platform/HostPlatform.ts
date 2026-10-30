// Everything the daemon does differently per operating system, in one place.
// `hostPlatform` (index.ts) is chosen once from process.platform; callers read
// what the system can do from here and never compare platform names themselves.

import type { UpdatePlatform } from "../../../contracts/src/update.ts";
import type { AppBundleCheck } from "../../../core/src/ports/Updates.ts";
import type { FsHelpers } from "../filesystem/FsHelpers.ts";

/** How the installed app takes in a new release on this system. */
export interface AppUpdatePlatform {
  /** The update feed's name for this system and CPU. */
  readonly feedPlatform: UpdatePlatform;
  /** The installed app the running executable belongs to, or null when it isn't inside one. */
  bundleRoot(execPath: string): string | null;
  readonly bundleCheck: AppBundleCheck;
  /** Files keep their permission bits here, so a staged copy's modes must match the release. */
  readonly fileModes: boolean;
}

export interface CredentialStore {
  /** Raw JSON of a Claude Code login store; no `storeDir` = the user's own Claude Code login. */
  readClaudeStore(storeDir?: string): string | null;
  /** Removes a store's login, as `claude auth logout` does. */
  clearClaudeStore(storeDir: string): void;
  /** A secret saved under `service` (a provider API key), or null. */
  readSecret(service: string): string | null;
  /** Saves a secret under `service`, replacing one already there. Throws when the system has no secret store. */
  writeSecret(service: string, secret: string): void;
}

export interface KeepAwakeOptions {
  /** Sleep stays held only while this process lives. */
  pid: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/** What Eos offers on this system; the dashboard hides what's off. */
export interface HostFeatures {
  /** Pairing with other computers and phones: controlling and hosting, file transfer, phone control. */
  remote: boolean;
  /** A POSIX shell for agents' commands exists (scriptShell); false = Windows without Git for Windows. */
  posixShell: boolean;
}

export interface Argv {
  file: string;
  args: string[];
}

/** The shell terminals and `!` commands run in. */
export interface TerminalShell {
  /** A terminal tab's shell; with `command` it runs that first, and stays open after unless `exitAfterCommand`. */
  interactive(opts?: { command?: string; exitAfterCommand?: boolean }): Argv;
  /** One command line, run without a terminal but with the user's shell profile. */
  run(command: string): Argv;
  /** A command line that runs `b` only when `a` fails. */
  orElse(a: string, b: string): string;
  /** A process in a terminal can write to that terminal's device (claudeLaunch's EOS_TTY hooks). */
  readonly ttyHooks: boolean;
}

/** How to start an executable: what spawn() gets. */
export interface SpawnCommand {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

export interface HostPlatform {
  /** The system's name as Node reports it — shown to paired devices, never branched on. */
  readonly os: string;
  /** Where the daemon's local control plane listens for the Eos home `home` (a unix socket, or a Windows named pipe). */
  controlSocket(home: string): string;
  readonly features: HostFeatures;
  /** The name people gave this computer, or null to fall back to the hostname. */
  friendlyComputerName(): string | null;
  /** A cap on open fds below RLIMIT_NOFILE, or null when the rlimit is the cap. */
  fdCeiling(): number | null;
  /** A recursive fs.watch costs no fd per file here, so it needn't go through chokidar. */
  readonly nativeRecursiveWatch: boolean;
  readonly credentials: CredentialStore;
  /** Moves a path to the system trash, or null when there is none to use. */
  readonly trash: ((path: string) => Promise<void>) | null;
  /** Keeps the computer out of system sleep until the returned release is called; null when unsupported. */
  keepAwake(opts: KeepAwakeOptions): (() => void) | null;
  createFsHelpers(opts: { repoRoot: string; iconCacheDir: string }): FsHelpers;
  readonly shell: TerminalShell;
  /**
   * The POSIX sh that agents' command lines run in (goal checks, the in-process
   * lanes' Bash tool) — they're written for sh on every system. null when the
   * system has none.
   */
  scriptShell(): string | null;
  /** The file names a CLI called `name` is installed under, in the order to look for them. */
  executableNames(name: string): string[];
  /** spawn() arguments that run `file` with `args` (a Windows .cmd shim only runs through cmd). */
  spawnCommand(file: string, args: string[]): SpawnCommand;
  /** Ends a process and everything it started (a detached child leads its own group). Throws when `pid` is gone. */
  killProcessTree(pid: number): void;
  /** Where a Chromium browser the browser panel can drive is usually installed, most preferred first. */
  chromiumBrowsers(): string[];
  /** In-app updates; null where Eos can't update itself yet. */
  readonly appUpdates: AppUpdatePlatform | null;
}
