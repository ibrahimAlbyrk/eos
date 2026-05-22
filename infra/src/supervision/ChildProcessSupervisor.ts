// ChildProcessSupervisor — wraps node:child_process behind the
// ProcessSupervisor port. Owns the children Map, escalation timers, and the
// SIGTERM/SIGKILL flow.

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import type { ProcessSupervisor, SpawnOptions, SupervisedProcess } from "../../../core/src/ports/ProcessSupervisor.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";

export interface ChildProcessSupervisorOptions {
  binary: string;        // typically "node"
  logger: Logger;
  defaultKillAfterMs?: number;
}

export function createChildProcessSupervisor(opts: ChildProcessSupervisorOptions): ProcessSupervisor & {
  shutdown(): void;
  findPidsByPattern(pattern: string): number[];
} {
  const children = new Map<string, ChildProcess>();
  const killAfter = opts.defaultKillAfterMs ?? 3000;

  return {
    spawn(id, spawnOpts: SpawnOptions): SupervisedProcess {
      const out = createWriteStream(spawnOpts.logFile);
      const child = spawn(opts.binary, spawnOpts.args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
        env: spawnOpts.env,
      });
      child.stdout?.pipe(out);
      child.stderr?.pipe(out);

      children.set(id, child);
      spawnOpts.onSpawn?.(child.pid ?? 0);

      child.on("exit", (code) => {
        children.delete(id);
        try { out.end(); } catch {}
        spawnOpts.onExit?.(code);
      });

      return { id, pid: child.pid ?? null };
    },

    has(id): boolean {
      return children.has(id);
    },

    escalateKill(id, killAfterMs = killAfter): void {
      const child = children.get(id);
      if (!child) return;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, killAfterMs);
    },

    killPid(pid, signal = "SIGTERM"): void {
      if (!pid || pid <= 0 || pid === process.pid) return;
      try { process.kill(pid, signal); } catch {
        // Process may already be gone — fine.
      }
    },

    listIds(): string[] {
      return Array.from(children.keys());
    },

    shutdown(): void {
      for (const [, child] of children) {
        try { child.kill("SIGTERM"); } catch {}
      }
    },

    findPidsByPattern(pattern): number[] {
      try {
        const out = execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" });
        return out.split(/\s+/).map(Number).filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}
