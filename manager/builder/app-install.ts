// Build + install the packaged Electron Eos.app into /Applications. This is the
// destructive, session-ending sibling of the converge engine: it replaces the
// running app and restarts its daemon, so `eos build` only reaches it behind the
// explicit `--app` flag. Restored (Electron-aware) from the old Swift-app step.
//
// Sequence: build (Forge prePackage bundles+assembles the daemon; postPackage
// ad-hoc re-signs with the correct identifier) → verify the signature identifier
// → RELIABLY terminate the running GUI app (graceful quit → poll → SIGTERM →
// SIGKILL) → stop its daemon → verify BOTH dead → swap the bundle in /Applications
// → force a clean LaunchServices re-registration + drop the icon cache + restart
// the Dock (guarantees the Dock icon) → relaunch a guaranteed-fresh instance →
// verify the new bundle is running.
//
// dryRun previews every command (including the build) and executes NONE — the
// safe way to inspect the install path without touching /Applications.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
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
// Per-user icon cache. Clearing it (no sudo) forces the Dock to re-render the
// bundle's icon instead of serving a stale/blank tile after a re-register.
const ICON_CACHE = join(homedir(), "Library", "Caches", "com.apple.iconservices.store");
// Matches EVERY process running out of the installed bundle — the GUI main, its
// "Eos Helper" processes, AND the daemon/workers (which exec the same Electron
// binary as node on a *.bundle.mjs entry). guiAppPids() filters the last group out.
const BUNDLE_PROC = "/Applications/Eos\\.app/";
const GUI_GRACE_MS = 8000; // how long to wait for a graceful quit before forcing
const FORCE_WAIT_MS = 3000; // per-signal wait during escalation
const RELAUNCH_WAIT_MS = 10000; // how long to wait for the new bundle to appear
const POLL_MS = 250;

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** pids whose full argv matches `pattern` (pgrep -f extended regex). */
function pidsMatching(pattern: string): number[] {
  const r = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
  return (r.stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** Full command line of a pid ("" once it is gone). */
function pidCommand(pid: number): string {
  return (spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "").trim();
}

/**
 * Live GUI-app processes of the installed bundle: the main Eos binary + its
 * "Eos Helper" processes — but NOT the daemon/workers, which exec the SAME
 * Electron binary as node on a *.bundle.mjs entry. Those are stopped separately
 * by stopDaemonAndOrphans so the daemon shuts its workers down gracefully.
 */
function guiAppPids(): number[] {
  return pidsMatching(BUNDLE_PROC).filter((pid) => !pidCommand(pid).includes(".bundle.mjs"));
}

/** Daemon process(es) running out of the installed bundle. */
function daemonPids(): number[] {
  return pidsMatching(`${BUNDLE_PROC}.*daemon\\.bundle\\.mjs`);
}

/** Poll `cond` until it holds or the deadline passes. */
async function pollUntil(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

/**
 * Terminate the running GUI app RELIABLY: ask it to quit gracefully (now that the
 * app's before-quit handler lets a real quit through), poll until it is gone, and
 * only if it lingers escalate SIGTERM → SIGKILL against fresh pid lists. Throws if
 * anything survives — the caller must not swap the bundle out from under a live app.
 */
async function terminateGuiApp(ctx: AppInstallCtx): Promise<void> {
  if (ctx.dryRun) {
    ctx.log(`● would run: osascript -e 'tell application "Eos" to quit'  (graceful)`);
    ctx.log(`● would poll up to ${GUI_GRACE_MS}ms for GUI processes to exit (pgrep -f '${BUNDLE_PROC}', minus *.bundle.mjs)`);
    ctx.log(`● would escalate if still alive: kill -TERM <gui pids> → wait → kill -KILL <gui pids>`);
    return;
  }
  ctx.log(`● quit running Eos.app — graceful → poll → force`);
  try {
    execFileSync("osascript", ["-e", 'tell application "Eos" to quit'], { stdio: "ignore" });
  } catch {}
  if (await pollUntil(() => guiAppPids().length === 0, GUI_GRACE_MS)) {
    ctx.log(`  ✓ GUI exited gracefully`);
    return;
  }
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    const pids = guiAppPids();
    if (pids.length === 0) break;
    ctx.log(`  GUI still alive (${pids.join(", ")}) — ${sig}`);
    for (const pid of pids) {
      try {
        process.kill(pid, sig);
      } catch {}
    }
    if (await pollUntil(() => guiAppPids().length === 0, FORCE_WAIT_MS)) break;
  }
  const left = guiAppPids();
  if (left.length) throw new Error(`could not terminate Eos GUI processes: ${left.join(", ")}`);
  ctx.log(`  ✓ GUI terminated`);
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

  // 3. Terminate the running GUI app (reliably), then stop its daemon by pid (the
  //    daemon is spawned detached, so quitting the app does NOT reap it unless the
  //    app spawned it). Reuses the same stop/orphan-reap `eos restart` uses. Both
  //    come back from the new bundle.
  await terminateGuiApp(ctx);
  if (ctx.dryRun) ctx.log(`● would run: stopDaemonAndOrphans(${ctx.pidFile})`);
  else await stopDaemonAndOrphans(ctx.pidFile);

  // 3b. Verify BOTH the GUI and the daemon are truly gone before the swap — never
  //     replace a bundle a live process is still executing from.
  if (!ctx.dryRun) {
    for (const pid of daemonPids()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    await pollUntil(() => daemonPids().length === 0, FORCE_WAIT_MS);
    const gui = guiAppPids();
    const dmn = daemonPids();
    if (gui.length || dmn.length) {
      throw new Error(`refusing to swap — still running: gui=[${gui.join(",")}] daemon=[${dmn.join(",")}]`);
    }
    ctx.log(`  ✓ app + daemon verified stopped`);
  }

  // 4. Swap the bundle. ditto (not cp -R) preserves the code signature + xattrs.
  step(ctx, `rm -rf ${INSTALL_DEST}`, () => {
    execFileSync("rm", ["-rf", INSTALL_DEST]);
  });
  step(ctx, `ditto ${built} ${INSTALL_DEST}`, () => {
    execFileSync("ditto", [built, INSTALL_DEST]);
  });

  // 5. Guarantee the Dock icon. The running app was observed registering as an
  //    accessory (LaunchServices type=UIElement, a `launch-disabled` bundle flag)
  //    even though nothing in the source or Info.plist requests it — a stale LS
  //    registration, not a code/config cause (a freshly-signed bundle registers as
  //    a normal foreground/Dock app). Force a clean re-registration, bump the
  //    bundle mtime so LS re-reads it, drop the per-user icon cache, and restart
  //    the Dock so the icon re-resolves.
  step(ctx, `lsregister -f ${INSTALL_DEST}`, () => {
    execFileSync(LSREGISTER, ["-f", INSTALL_DEST]);
  });
  step(ctx, `touch ${INSTALL_DEST}`, () => {
    try {
      execFileSync("touch", [INSTALL_DEST]);
    } catch {}
  });
  step(ctx, `rm -rf ${ICON_CACHE}`, () => {
    try {
      execFileSync("rm", ["-rf", ICON_CACHE]);
    } catch {}
  });
  step(ctx, `killall Dock`, () => {
    try {
      execFileSync("killall", ["Dock"]);
    } catch {}
  });

  // 6. Relaunch a guaranteed-fresh instance — the old one is verified dead, so
  //    open -n starts the newly-swapped bundle rather than reactivating a stale
  //    LaunchServices ASN. The new app spawns its own daemon.
  step(ctx, `open -n ${INSTALL_DEST}`, () => {
    execFileSync("open", ["-n", INSTALL_DEST]);
  });

  // 7. Verify the relaunch actually produced a running instance of the new bundle.
  if (ctx.dryRun) {
    ctx.log(`● would verify the new bundle is running (poll pgrep up to ${RELAUNCH_WAIT_MS}ms)`);
  } else {
    if (!(await pollUntil(() => guiAppPids().length > 0, RELAUNCH_WAIT_MS))) {
      throw new Error("relaunched app did not appear — check ~/.eos/logs/daemon.log");
    }
    ctx.log(`  ✓ new bundle running (pid ${guiAppPids()[0]})`);
  }

  ctx.log(ctx.dryRun ? "app install: dry-run (nothing changed)" : "app installed + relaunched");
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
