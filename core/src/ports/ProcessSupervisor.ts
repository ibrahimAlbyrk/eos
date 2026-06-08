// ProcessSupervisor — abstracts child process spawn/kill so the daemon
// doesn't import node:child_process directly. Adapter is
// ChildProcessSupervisor in infra/supervision/.

export interface SpawnOptions {
  args: string[];
  env: Record<string, string>;
  logFile: string;
  /** Called once after the child has been spawned with its OS pid. */
  onSpawn?(pid: number): void;
  /** Called when the child exits with its numeric exit code (signal → 128+n). */
  onExit?(code: number | null): void;
}

export interface SupervisedProcess {
  readonly id: string;
  readonly pid: number | null;
}

export interface ProcessSupervisor {
  /** Spawns a long-lived child process. Returns the supervised handle. */
  spawn(id: string, opts: SpawnOptions): SupervisedProcess;
  /** Tracks a child? Useful for liveness probes. */
  has(id: string): boolean;
  /** Two-phase kill: SIGTERM now, SIGKILL after `killAfterMs`. No-op if the
   * id is unknown (already exited). */
  escalateKill(id: string, killAfterMs?: number): void;
  /** Best-effort SIGTERM to an arbitrary OS pid (used to clean orphan
   * eos-* claude children that aren't tracked by id). */
  killPid(pid: number, signal?: "SIGTERM" | "SIGKILL"): void;
  /** All currently tracked ids — used by shutdown to fan out SIGTERMs. */
  listIds(): string[];
}
