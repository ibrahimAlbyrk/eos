import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StartupBackupService } from "../StartupBackupService.ts";

describe("StartupBackupService", () => {
  let home: string;
  let backups: string;
  let tick: number;
  let svc: StartupBackupService;

  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bkp-test-"));
    backups = join(home, "backups");
    tick = 0;
    svc = new StartupBackupService({ home, backupsDir: backups, keep: 5, minIntervalMs: 0, now });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns null and writes nothing when no user data exists", () => {
    assert.equal(svc.run(), null);
    assert.equal(existsSync(backups), false);
  });

  it("snapshots only present manifest entries, dirs recursively", () => {
    writeFileSync(join(home, "state.db"), "db");
    writeFileSync(join(home, "policy.yaml"), "default: ask");
    mkdirSync(join(home, "templates"));
    writeFileSync(join(home, "templates", "a.md"), "tpl");
    const dst = svc.run();
    assert.ok(dst);
    assert.equal(readFileSync(join(dst, "state.db"), "utf8"), "db");
    assert.equal(readFileSync(join(dst, "policy.yaml"), "utf8"), "default: ask");
    assert.equal(readFileSync(join(dst, "templates", "a.md"), "utf8"), "tpl");
    assert.equal(existsSync(join(dst, "config.json")), false);
  });

  it("skips Chrome's regenerable cache dirs but keeps browser logins", async () => {
    const profile = join(home, "browser", "profile");
    mkdirSync(join(profile, "Default", "Cache"), { recursive: true });
    mkdirSync(join(profile, "optimization_guide_model_store"), { recursive: true });
    writeFileSync(join(profile, "Default", "Cache", "blob"), "x");
    writeFileSync(join(profile, "optimization_guide_model_store", "model"), "x");
    writeFileSync(join(profile, "Default", "Cookies"), "session");
    const dst = svc.run();
    assert.ok(dst);
    await svc.finish(dst);
    const copied = join(dst, "browser", "profile");
    assert.equal(readFileSync(join(copied, "Default", "Cookies"), "utf8"), "session");
    assert.equal(existsSync(join(copied, "Default", "Cache")), false);
    assert.equal(existsSync(join(copied, "optimization_guide_model_store")), false);
  });

  it("keeps only the newest N snapshots and ignores legacy .bak files", async () => {
    writeFileSync(join(home, "state.db"), "db");
    mkdirSync(backups, { recursive: true });
    writeFileSync(join(backups, "state.db.2026-06-01T00-00-00.bak"), "legacy");
    for (let i = 0; i < 7; i++) await svc.finish(svc.run()!);
    const entries = readdirSync(backups);
    const snaps = entries.filter((n) => !n.endsWith(".bak")).sort();
    assert.equal(snaps.length, 5);
    assert.ok(entries.includes("state.db.2026-06-01T00-00-00.bak"));
    assert.ok(snaps.includes("2026-01-01T00-00-06"));
    assert.equal(snaps.includes("2026-01-01T00-00-00"), false);
  });

  it("defers browser profiles to finish() so run() stays fast", async () => {
    writeFileSync(join(home, "state.db"), "db");
    mkdirSync(join(home, "browser", "profile", "Default"), { recursive: true });
    writeFileSync(join(home, "browser", "profile", "Default", "Cookies"), "session");
    const dst = svc.run();
    assert.ok(dst);
    assert.equal(readFileSync(join(dst, "state.db"), "utf8"), "db");
    assert.equal(existsSync(join(dst, "browser")), false);
    await svc.finish(dst);
    assert.equal(readFileSync(join(dst, "browser", "profile", "Default", "Cookies"), "utf8"), "session");
  });

  it("skips a snapshot while the newest one is younger than minIntervalMs", () => {
    writeFileSync(join(home, "state.db"), "db");
    const hourly = new StartupBackupService({ home, backupsDir: backups, minIntervalMs: 60 * 60 * 1000, now });
    assert.ok(hourly.run());
    assert.equal(hourly.run(), null);
    tick += 60 * 60;
    assert.ok(hourly.run());
  });
});
