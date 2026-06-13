// UpdateApplier — applies an available update: pulls the new source and
// re-converges the running install. `eos build` restarts the very daemon that
// invokes this, so application is inherently fire-and-forget — the concrete
// adapter spawns a DETACHED process that outlives the daemon it replaces.

export interface ApplyUpdateOptions {
  repoRoot: string;
  /** false → the build runs with `--no-relaunch` because the caller (the native
   *  launch splash) drives its own reload; true → the build reloads/relaunches
   *  the running app itself (the in-app banner path). */
  relaunchApp: boolean;
}

export interface UpdateApplier {
  apply(opts: ApplyUpdateOptions): void;
}
