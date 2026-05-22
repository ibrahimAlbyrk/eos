// Command pattern — each CLI verb implements this interface. Adding a new
// command is one new file + one entry in the registry; cli.ts no longer
// needs to grow a new switch arm. Argument parsing happens inside the
// command so each can own its own flags.

import type { DaemonConfig } from "../../shared/config.ts";

export interface CommandContext {
  daemonUrl: string;
  repoRoot: string;
  logDir: string;
  config: DaemonConfig;
  /** CLI-flavored daemon fetch — exits process on transport/HTTP failures.
   * Library-style throwing variant lives in shared/http.ts as daemonApi. */
  api(method: string, path: string, body?: unknown): Promise<unknown>;
}

export interface Command {
  readonly name: string;
  /** Aliases that route to the same command (e.g. "ls" → list, "stop" → kill). */
  readonly aliases?: ReadonlyArray<string>;
  readonly description: string;
  /** Optional usage line for the help command. */
  readonly usage?: string;
  run(args: string[], ctx: CommandContext): Promise<void>;
}
