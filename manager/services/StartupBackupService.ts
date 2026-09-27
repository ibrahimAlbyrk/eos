// StartupBackupService — snapshots the user-data manifest (shared/user-data.ts)
// into <backupsDir>/<stamp>/ on daemon boot, keeping the newest `keep` snapshots.
// Legacy flat `state.db.*.bak` files from the old inline backup are ignored by
// the prune.
//
// Split in two so a snapshot never delays the daemon's listen():
//   run()    — sync, BEFORE the DB is opened (a pending migration must not run
//              ahead of the DB copy): every entry except the browser profiles.
//   finish() — async, after the daemon is serving: browser profiles + prune.

import { constants, cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { basename, join } from "node:path";

import { USER_DATA_ENTRIES } from "../shared/user-data.ts";

const SNAPSHOT_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})$/;

// Copy-on-write clone on APFS (near-instant); falls back to a plain copy elsewhere.
const CLONE = { recursive: true, mode: constants.COPYFILE_FICLONE };

// Thousands of small files — too slow for the pre-listen window.
const DEFERRED_ENTRIES = new Set<string>(["browser"]);

// Chrome re-downloads/rebuilds these on its own; they are ~90% of a browser
// profile's size, while the logins worth backing up (cookies, storage) are tiny.
const BROWSER_REGENERABLE_DIRS = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "DawnWebGPUCache",
  "DawnGraphiteCache",
  "GraphiteDawnCache",
  "optimization_guide_model_store",
  "component_crx_cache",
  "WasmTtsEngine",
  "Safe Browsing",
  "OnDeviceHeadSuggestModel",
  "CertificateRevocation",
  "ActorSafetyLists",
  "ZxcvbnData",
]);

export interface StartupBackupOptions {
  home: string;
  backupsDir: string;
  keep?: number;
  /** A burst of restarts (dev loop, `eos build`) must not rotate every older,
   *  genuinely different snapshot out — skip when the newest is younger than this. */
  minIntervalMs?: number;
  now?: () => Date;
}

export class StartupBackupService {
  private readonly home: string;
  private readonly backupsDir: string;
  private readonly keep: number;
  private readonly minIntervalMs: number;
  private readonly now: () => Date;

  constructor(opts: StartupBackupOptions) {
    this.home = opts.home;
    this.backupsDir = opts.backupsDir;
    this.keep = opts.keep ?? 3;
    this.minIntervalMs = opts.minIntervalMs ?? 60 * 60 * 1000;
    this.now = opts.now ?? (() => new Date());
  }

  /** Returns the snapshot dir to hand to finish(), or null when skipped. */
  run(): string | null {
    const present = USER_DATA_ENTRIES.filter((e) => existsSync(join(this.home, e)));
    if (present.length === 0) return null;
    const now = this.now();
    if (this.isRecentSnapshot(now)) return null;
    const dst = join(this.backupsDir, now.toISOString().replace(/[:.]/g, "-").slice(0, 19));
    mkdirSync(dst, { recursive: true });
    for (const entry of present) {
      if (!DEFERRED_ENTRIES.has(entry)) cpSync(join(this.home, entry), join(dst, entry), CLONE);
    }
    return dst;
  }

  async finish(dst: string): Promise<void> {
    for (const entry of DEFERRED_ENTRIES) {
      const src = join(this.home, entry);
      if (!existsSync(src)) continue;
      await cp(src, join(dst, entry), {
        ...CLONE,
        filter: (path) => !BROWSER_REGENERABLE_DIRS.has(basename(path)),
      });
    }
    await this.prune();
  }

  private snapshots(): string[] {
    if (!existsSync(this.backupsDir)) return [];
    return readdirSync(this.backupsDir).filter((n) => SNAPSHOT_RE.test(n)).sort().reverse();
  }

  private isRecentSnapshot(now: Date): boolean {
    const m = SNAPSHOT_RE.exec(this.snapshots()[0] ?? "");
    if (!m) return false;
    const takenAt = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
    return now.getTime() - takenAt < this.minIntervalMs;
  }

  private async prune(): Promise<void> {
    for (const old of this.snapshots().slice(this.keep)) {
      try { await rm(join(this.backupsDir, old), { recursive: true, force: true }); } catch {}
    }
  }
}
