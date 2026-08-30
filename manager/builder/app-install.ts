// Build + install the packaged Electron Eos.app into /Applications. This is the
// destructive, session-ending sibling of the converge engine: it replaces the
// running app and restarts its daemon, so `eos build` only reaches it behind the
// explicit `--app` flag. Restored (Electron-aware) from the old Swift-app step.
//
// Sequence: build (Forge prePackage bundles+assembles the daemon; postPackage
// ad-hoc re-signs with the correct identifier) → verify the signature identifier
// → quit the running app + stop its daemon → swap the bundle in /Applications →
// re-register with LaunchServices + refresh the Dock → relaunch.
//
// dryRun previews every command (including the build) and executes NONE — the
// safe way to inspect the install path without touching /Applications.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { stopDaemonAndOrphans } from "../cli/daemon-lifecycle.ts";

export interface AppInstallCtx {
  repoRoot: string;
  /** ~/.eos/daemon.pid — the running daemon is stopped by pid before the swap. */
  pidFile: string;
  dryRun: boolean;
  log(line: string): void;
}

const APP_BUNDLE_ID = "com.ibrahimalbyrk.eos";
const INSTALL_DEST = "/Applications/Eos.app";
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

function builtAppPath(repoRoot: string): string {
  // arm64-only for now (per the standalone-packaging plan); process.arch tracks
  // the arch this CLI runs under, which is the arch Forge just built.
  return join(repoRoot, "app", "out", `Eos-darwin-${process.arch}`, "Eos.app");
}

/** Top-level code-signature Identifier (codesign writes -dv output to stderr). */
function signatureIdentifier(appPath: string): string | null {
  const r = spawnSync("codesign", ["-dv", appPath], { encoding: "utf8" });
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const m = text.match(/^Identifier=(.+)$/m);
  return m ? m[1].trim() : null;
}

/** Run a shell step, or just print it under dryRun. */
function step(ctx: AppInstallCtx, label: string, run: () => void): void {
  if (ctx.dryRun) {
    ctx.log(`● would run: ${label}`);
    return;
  }
  ctx.log(`● ${label}`);
  run();
}

export async function buildAndInstallApp(ctx: AppInstallCtx): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("eos build --app installs a macOS .app bundle — darwin only");
  }
  const appDir = join(ctx.repoRoot, "app");
  const built = builtAppPath(ctx.repoRoot);

  // 1. Build the packaged app. Forge's prePackage builds the UI + bundles/assembles
  //    the standalone daemon; postPackage ad-hoc re-signs with the correct identifier.
  step(ctx, `build packaged app — npm --prefix ${appDir} run package`, () => {
    execFileSync("npm", ["--prefix", appDir, "run", "package"], { stdio: "inherit" });
  });

  // 2. Verify the fresh bundle carries the correct signature identifier — the
  //    whole point of the Dock fix. Bail before touching /Applications if not.
  if (!ctx.dryRun) {
    if (!existsSync(built)) throw new Error(`built app not found at ${built}`);
    const id = signatureIdentifier(built);
    if (id !== APP_BUNDLE_ID) {
      throw new Error(`built app signature Identifier=${id ?? "?"} (expected ${APP_BUNDLE_ID}) — Dock fix would not take`);
    }
    ctx.log(`  ✓ signature Identifier=${id}`);
  }

  // 3. Quit the running GUI app, then stop its daemon by pid (the daemon is
  //    spawned detached, so quitting the app does NOT reap it). Reuses the same
  //    stop/orphan-reap `eos restart` uses. Both come back from the new bundle.
  step(ctx, `quit running Eos.app`, () => {
    try {
      execFileSync("osascript", ["-e", 'tell application "Eos" to quit'], { stdio: "ignore" });
    } catch {}
    try {
      execFileSync("killall", ["Eos"], { stdio: "ignore" });
    } catch {}
  });
  if (ctx.dryRun) ctx.log(`● would run: stopDaemonAndOrphans(${ctx.pidFile})`);
  else await stopDaemonAndOrphans(ctx.pidFile);

  // 4. Swap the bundle. ditto (not cp -R) preserves the code signature + xattrs.
  step(ctx, `rm -rf ${INSTALL_DEST}`, () => {
    execFileSync("rm", ["-rf", INSTALL_DEST]);
  });
  step(ctx, `ditto ${built} ${INSTALL_DEST}`, () => {
    execFileSync("ditto", [built, INSTALL_DEST]);
  });

  // 5. Re-register with LaunchServices + refresh the Dock so the icon resolves.
  step(ctx, `lsregister -f ${INSTALL_DEST}`, () => {
    execFileSync(LSREGISTER, ["-f", INSTALL_DEST]);
  });
  step(ctx, `killall Dock`, () => {
    try {
      execFileSync("killall", ["Dock"]);
    } catch {}
  });

  // 6. Relaunch — the new app spawns its own daemon.
  step(ctx, `open ${INSTALL_DEST}`, () => {
    execFileSync("open", [INSTALL_DEST]);
  });

  ctx.log(ctx.dryRun ? "app install: dry-run (nothing changed)" : "app installed + relaunched");
}
