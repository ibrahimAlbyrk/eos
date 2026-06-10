// One build artifact = one step. Every step is self-verifying: the stamp it
// reports in currentStamp() lives WITH the artifact (file inside it, or the
// daemon's /health), never in a side manifest — deleting an artifact or
// stamp makes it dirty again automatically.

export interface BuildCtx {
  repoRoot: string;
  daemonUrl: string;
  /** ~/.eos — lock file + config.json live here. */
  eosHome: string;
  /** ~/.eos/daemon.pid */
  pidFile: string;
  force: boolean;
  dryRun: boolean;
  noApp: boolean;
  open: boolean;
  log(line: string): void;
}

export interface BuildStep {
  id: string;
  /** e.g. {run: "installing", done: "installed"} for output lines. */
  verb: { run: string; done: string };
  /** Printed when currentStamp() is null (e.g. "daemon down or unstamped"). */
  missingReason?: string;
  desiredStamp(ctx: BuildCtx): string | Promise<string>;
  currentStamp(ctx: BuildCtx): string | null | Promise<string | null>;
  /**
   * Must leave the step converged: after apply, currentStamp() must equal a
   * freshly recomputed desiredStamp(). The engine verifies (recomputing both,
   * because apply may legitimately rewrite its own inputs — npm install can
   * touch package-lock.json).
   */
  apply(ctx: BuildCtx, desired: string): Promise<void>;
}
