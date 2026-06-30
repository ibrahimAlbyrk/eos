// NodeProcessRunner — the child_process adapter for the shell built-ins' ProcessRunner
// port. Foreground runs go through `/bin/sh -c` with a cwd + timeout; background
// shells are tracked in a registry so BashOutput reads incrementally and KillShell
// can terminate them. The background registry is process-global (shell ids are
// unique), shared across all in-process sessions.

import { spawn, type ChildProcess } from "node:child_process";
import type {
  ProcessRunner,
  ProcessResult,
  ProcessRunOptions,
  BackgroundReadResult,
} from "../../../core/src/ports/ProcessRunner.ts";

const DEFAULT_TIMEOUT_MS = 120_000;

interface BgShell {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  outCursor: number;
  errCursor: number;
  running: boolean;
  exitCode: number | null;
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
        child.stdout?.on("data", (d) => { stdout += d.toString(); });
        child.stderr?.on("data", (d) => { stderr += d.toString(); });
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
      const shell: BgShell = { child, stdout: "", stderr: "", outCursor: 0, errCursor: 0, running: true, exitCode: null };
      child.stdout?.on("data", (d) => { shell.stdout += d.toString(); });
      child.stderr?.on("data", (d) => { shell.stderr += d.toString(); });
      child.on("error", (e) => { shell.stderr += e instanceof Error ? e.message : String(e); shell.running = false; });
      child.on("close", (code) => { shell.running = false; shell.exitCode = code; });
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
      return { stdout, stderr, running: s.running, exitCode: s.exitCode };
    },

    killBackground(id): boolean {
      const s = bg.get(id);
      if (!s) return false;
      if (s.running) s.child.kill("SIGKILL");
      s.running = false;
      return true;
    },
  };
}
