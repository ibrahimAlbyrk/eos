// Interactive-PTY host — a thin wrapper over node-pty for the embedded
// multi-tab terminal (the `pty` feature; distinct from the one-shot `!`
// composer runner). node-pty is declared ONLY in spawner/package.json and
// resolves ONLY from spawner/node_modules; the daemon (Node) imports this
// module relatively, mirroring the ../../spawner/canonical-map.ts import at
// manager/routes/workers.ts.
//
// API mirrors spawner/worker.ts's node-pty usage (spawn/onData/onExit/write/
// kill) PLUS resize(), which worker.ts never needs. The shell is the user's
// LOGIN shell with a TTY so zsh/bash source their rc files and render the real
// prompt — no `-c`, this is an interactive session, not a command runner.

import { spawn as ptySpawn, type IPty } from "@homebridge/node-pty-prebuilt-multiarch";

export interface PtyHostOptions {
  cwd: string;
  cols: number;
  rows: number;
}

export interface PtyHost {
  onData(cb: (data: string) => void): void;
  onExit(cb: (exitCode: number) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export function spawnPtyHost(opts: PtyHostOptions): PtyHost {
  const shell = process.env.SHELL || "/bin/bash";
  const pty: IPty = ptySpawn(shell, ["-l"], {
    cwd: opts.cwd,
    cols: opts.cols,
    rows: opts.rows,
    // The user's real env, nothing stripped — this is the operator's own shell.
    env: { ...process.env, TERM: "xterm-256color" },
  });
  return {
    onData: (cb) => { pty.onData(cb); },
    onExit: (cb) => { pty.onExit(({ exitCode }) => cb(exitCode)); },
    write: (data) => { pty.write(data); },
    resize: (cols, rows) => { pty.resize(cols, rows); },
    kill: () => { try { pty.kill(); } catch {} },
  };
}

export type SpawnPtyHost = typeof spawnPtyHost;
