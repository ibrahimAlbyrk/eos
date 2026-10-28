// Interactive-PTY host — a thin wrapper over node-pty for the embedded
// multi-tab terminal (the `pty` feature; distinct from the one-shot `!`
// composer runner). node-pty is declared ONLY in spawner/package.json and
// resolves ONLY from spawner/node_modules; the daemon (Node) imports this
// module relatively, mirroring the ../../spawner/canonical-map.ts import at
// manager/routes/workers.ts.
//
// API mirrors spawner/worker.ts's node-pty usage (spawn/onData/onExit/write/
// kill) PLUS resize(), which worker.ts never needs. The shell is the host
// platform's interactive shell (on macOS the user's LOGIN shell with a TTY, so
// rc files are sourced and the real prompt renders).

import { spawn as ptySpawn, type IPty } from "node-pty";
import { hostPlatform } from "../infra/src/platform/index.ts";

export interface PtyHostOptions {
  cwd: string;
  cols: number;
  rows: number;
  command?: string;
  /** End the session when `command` exits instead of dropping into a login shell
   *  — for one-shot TUIs driven by the daemon (e.g. `claude setup-token`). */
  exitAfterCommand?: boolean;
  /** Child env; defaults to the daemon's own env (see ptyEnv). */
  env?: Record<string, string | undefined>;
}

export interface PtyHost {
  onData(cb: (data: string) => void): void;
  onExit(cb: (exitCode: number) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  // Name of the terminal's foreground process (e.g. the shell, or Claude).
  foreground(): string;
}

export function spawnPtyHost(opts: PtyHostOptions): PtyHost {
  const { file, args } = hostPlatform.shell.interactive({ command: opts.command, exitAfterCommand: opts.exitAfterCommand });
  const pty: IPty = ptySpawn(file, args, {
    cwd: opts.cwd,
    cols: opts.cols,
    rows: opts.rows,
    env: ptyEnv(opts.env ?? process.env),
  });
  return {
    onData: (cb) => { pty.onData(cb); },
    onExit: (cb) => { pty.onExit(({ exitCode }) => cb(exitCode)); },
    write: (data) => { pty.write(data); },
    resize: (cols, rows) => { pty.resize(cols, rows); },
    kill: () => { try { pty.kill(); } catch {} },
    foreground: () => pty.process,
  };
}

// The user's real env (this is the operator's own shell) with the terminal
// identity overridden: an inherited TERM_PROGRAM (daemon launched from Ghostty or
// iTerm) makes TUIs apply that terminal's quirks to our xterm.js. COLORTERM keeps
// truecolor on (xterm.js supports it; without it TUIs fall back to 256 colors).
// FORCE_HYPERLINK makes Claude Code and other supports-hyperlinks tools emit
// clickable OSC 8 links.
export function ptyEnv(base: Record<string, string | undefined>): Record<string, string | undefined> {
  const { TERM_PROGRAM_VERSION: _version, ...env } = base;
  return { ...env, TERM: "xterm-256color", TERM_PROGRAM: "eos", COLORTERM: "truecolor", FORCE_HYPERLINK: "1" };
}

export type SpawnPtyHost = typeof spawnPtyHost;
