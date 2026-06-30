// ProcessRunner — the DIP seam the shell built-ins (Bash/BashOutput/KillShell)
// and Grep (ripgrep) depend on, so they unit-test against a fake with no real
// subprocess. The Node adapter (infra/src/tools/NodeProcessRunner) owns child_process
// + the background-shell registry. Foreground runs are one-shot with a timeout +
// cwd; background runs are tracked by id for incremental reads + kill.

export interface ProcessResult {
  stdout: string;
  stderr: string;
  // null when the process was killed by a signal (timeout) rather than exiting.
  exitCode: number | null;
  timedOut: boolean;
}

export interface ProcessRunOptions {
  cwd: string;
  /** Kill the process after this many ms (foreground only). */
  timeoutMs?: number;
}

// One background shell's accumulated output since the last read (BashOutput is
// incremental, like the bundled binary): the runner advances a per-shell cursor.
export interface BackgroundReadResult {
  stdout: string; // new stdout since the previous read
  stderr: string; // new stderr since the previous read
  running: boolean;
  exitCode: number | null;
}

export interface ProcessRunner {
  run(command: string, opts: ProcessRunOptions): Promise<ProcessResult>;
  /** Spawn a detached background shell; returns its id (for BashOutput / KillShell). */
  startBackground(command: string, opts: ProcessRunOptions): string;
  /** Incremental read of a background shell (null ⇒ unknown id). */
  readBackground(id: string): BackgroundReadResult | null;
  /** Kill a background shell (false ⇒ unknown id / already gone). */
  killBackground(id: string): boolean;
}
