// StartupBackupService — snapshots the user-data manifest (shared/user-data.ts)
// into <backupsDir>/<stamp>/ on daemon boot, before the DB is opened, keeping
// the newest `keep` snapshots. Legacy flat `state.db.*.bak` files from the old
// inline backup are ignored by the prune.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { USER_DATA_ENTRIES } from "../shared/user-data.ts";

const SNAPSHOT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;

export class StartupBackupService {
  private readonly home: string;
  private readonly backupsDir: string;
  private readonly keep: number;
  private readonly now: () => Date;

  constructor(home: string, backupsDir: string, keep = 5, now: () => Date = () => new Date()) {
    this.home = home;
    this.backupsDir = backupsDir;
    this.keep = keep;
    this.now = now;
  }

  run(): string | null {
    const present = USER_DATA_ENTRIES.filter((e) => existsSync(join(this.home, e)));
    if (present.length === 0) return null;
    const stamp = this.now().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dst = join(this.backupsDir, stamp);
    mkdirSync(dst, { recursive: true });
    for (const entry of present) {
      cpSync(join(this.home, entry), join(dst, entry), { recursive: true });
    }
    this.prune();
    return dst;
  }

  private prune(): void {
    const snaps = readdirSync(this.backupsDir)
      .filter((n) => SNAPSHOT_RE.test(n))
      .sort()
      .reverse();
    for (const old of snaps.slice(this.keep)) {
      try { rmSync(join(this.backupsDir, old), { recursive: true, force: true }); } catch {}
    }
  }
}
