// NodeProcessRunner — the child_process adapter for the shell built-ins' ProcessRunner
// port. Foreground runs go through `/bin/sh -c` with a cwd + timeout; background
// shells are tracked in a registry so BashOutput reads incrementally and KillShell
// can terminate them. The background registry is process-global (shell ids are
// unique), shared across all in-process sessions; each shell is tagged with its
// owner (session/worker id) so reap() can free exactly one session's shells.

import { spawn, type ChildProcess } from "node:child_process";
import type {
  ProcessRunner,
  ProcessResult,
  ProcessRunOptions,
  BackgroundReadResult,
} from "../../../core/src/ports/ProcessRunner.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
// Cap on how much of one stream we retain in memory so a runaway command can't grow
// the daemon's heap without bound (m2). Past the cap we stop appending and add a
// one-time marker; foreground and background shells share it.
const MAX_OUTPUT_CHARS = 5_000_000;

interface BgShell {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  outCursor: number;
  errCursor: number;
  running: boolean;
  exitCode: number | null;
  owner?: string;
  timer?: ReturnType<typeof setTimeout>;
}

// Append to a stream buffer but never exceed MAX_OUTPUT_CHARS; the first overflow
// appends a truncation marker so the consumer knows output was dropped.
function appendCapped(buf: string, chunk: string): string {
  if (buf.length >= MAX_OUTPUT_CHARS) return buf;
  const next = buf + chunk;
  return next.length <= MAX_OUTPUT_CHARS ? next : next.slice(0, MAX_OUTPUT_CHARS) + "\n[output truncated]";
}

export function createNodeProcessRunner(): ProcessRunner {
  const bg = new Map<string, BgShell>();
  let counter = 0;

  return {
    run(command, opts): Promise<ProcessResult> {
      return new Promise((resolve) => {
        // stdin: "ignore" so a command that reads stdin (e.g. a path-less `rg`, `cat`)
        // gets EOF instead of blocking on a never-closed pipe.
        const child = spawn(command, { cwd: opts.cwd, shell: "/bin/sh", stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);
        child.stdout?.on("data", (d) => { stdout = appendCapped(stdout, d.toString()); });
        child.stderr?.on("data", (d) => { stderr = appendCapped(stderr, d.toString()); });
        child.on("error", (e) => {
          clearTimeout(timer);
          resolve({ stdout, stderr: stderr || (e instanceof Error ? e.message : String(e)), exitCode: null, timedOut });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, exitCode: code, timedOut });
        });
      });
    },

    startBackground(command, opts): string {
      const id = `bash_${++counter}`;
      const child = spawn(command, { cwd: opts.cwd, shell: "/bin/sh", detached: false, stdio: ["ignore", "pipe", "pipe"] });
      const shell: BgShell = { child, stdout: "", stderr: "", outCursor: 0, errCursor: 0, running: true, exitCode: null, owner: opts.owner };
      // Honor timeoutMs for background shells too (previously ignored): a runaway
      // detached job is SIGKILLed instead of running forever.
      if (opts.timeoutMs) shell.timer = setTimeout(() => { if (shell.running) shell.child.kill("SIGKILL"); }, opts.timeoutMs);
      child.stdout?.on("data", (d) => { shell.stdout = appendCapped(shell.stdout, d.toString()); });
      child.stderr?.on("data", (d) => { shell.stderr = appendCapped(shell.stderr, d.toString()); });
      child.on("error", (e) => { shell.stderr = appendCapped(shell.stderr, e instanceof Error ? e.message : String(e)); shell.running = false; if (shell.timer) clearTimeout(shell.timer); });
      child.on("close", (code) => { shell.running = false; shell.exitCode = code; if (shell.timer) clearTimeout(shell.timer); });
      bg.set(id, shell);
      return id;
    },

    readBackground(id): BackgroundReadResult | null {
      const s = bg.get(id);
      if (!s) return null;
      const stdout = s.stdout.slice(s.outCursor);
      const stderr = s.stderr.slice(s.errCursor);
      s.outCursor = s.stdout.length;
      s.errCursor = s.stderr.length;
      // Evict a finished shell once this read has drained its final output, so
      // completed background shells don't accumulate over a long session (MJ2/m2).
      // The final output is returned by THIS call before the entry is dropped; a
      // subsequent read of the same id returns null (already reaped).
      if (!s.running) bg.delete(id);
      return { stdout, stderr, running: s.running, exitCode: s.exitCode };
    },

    killBackground(id): boolean {
      const s = bg.get(id);
      if (!s) return false;
      if (s.timer) clearTimeout(s.timer);
      if (s.running) s.child.kill("SIGKILL");
      s.running = false;
      bg.delete(id); // an explicitly killed shell is gone — free it immediately
      return true;
    },

    reap(owner): void {
      // Kill + evict every background shell owned by a stopping session, so an
      // in-process worker kill doesn't orphan its run_in_background children (MJ2).
      for (const [id, s] of bg) {
        if (s.owner !== owner) continue;
        if (s.timer) clearTimeout(s.timer);
        if (s.running) s.child.kill("SIGKILL");
        bg.delete(id);
      }
    },
  };
}
