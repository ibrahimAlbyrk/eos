// DetachedBuildApplier — applies an update by running `git pull --ff-only`
// then `eos build` in a DETACHED child process. `eos build` SIGTERMs the very
// daemon that triggered the apply, so the work must outlive it: detached +
// unref'd, stdio redirected to ~/.eos/logs/update.log. The two steps are
// chained with `&&` so a failed ff-only pull (diverged / offline) skips the
// rebuild entirely and leaves the running install untouched.

import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { UpdateApplier, ApplyUpdateOptions } from "../../../core/src/ports/UpdateApplier.ts";

// Single-quote for the shell; the only interpolated values are our own config
// paths, but quoting keeps a space-containing repo path from splitting.
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface DetachedBuildApplierOpts {
  /** ~/.eos/logs — update.log lands here. */
  logDir: string;
  /** node binary that runs the strip-types CLI; defaults to this process's. */
  nodePath?: string;
}

export function createDetachedBuildApplier(opts: DetachedBuildApplierOpts): UpdateApplier {
  const node = opts.nodePath ?? process.execPath;
  return {
    apply({ repoRoot, relaunchApp }: ApplyUpdateOptions): void {
      const cli = join(repoRoot, "manager", "cli.ts");
      const buildFlags = relaunchApp ? "--open" : "--no-relaunch";
      const script =
        `cd ${shq(repoRoot)} && git pull --ff-only && ` +
        `exec ${shq(node)} --experimental-strip-types ${shq(cli)} build ${buildFlags}`;

      // A daemon launched from the macOS GUI inherits a minimal PATH; prepend
      // the dirs the toolchain (node/npm, the eos launcher) usually lives in so
      // the build can find them. swiftc/codesign resolve from /usr/bin already.
      const extraPath = [
        dirname(node),
        join(homedir(), ".local", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
      ].join(":");
      const env = { ...process.env, PATH: `${extraPath}:${process.env.PATH ?? ""}` };

      let out: number | "ignore" = "ignore";
      try {
        out = openSync(join(opts.logDir, "update.log"), "a");
      } catch {
        // logging is best-effort; the update still runs blind if this fails
      }
      const child = spawn("bash", ["-c", script], {
        cwd: repoRoot,
        detached: true,
        stdio: ["ignore", out, out],
        env,
      });
      child.unref();
    },
  };
}
