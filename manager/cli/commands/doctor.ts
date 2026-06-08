import { execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Command } from "./Command.ts";

export const doctorCommand: Command = {
  name: "doctor",
  description: "Environment + daemon sanity checks (DB size, orphan processes, stuck pending)",
  usage: "eos doctor",
  async run(_args, ctx): Promise<void> {
    const home = ctx.config.daemon.home;
    const issues: string[] = [];
    const ok = (m: string): void => { console.log(`  ✓ ${m}`); };
    const warn = (m: string): void => { issues.push(m); console.log(`  ⚠ ${m}`); };

    console.log("eos doctor\n");

    let daemonUp = false;
    try {
      const r = await fetch(`${ctx.daemonUrl}/health`);
      daemonUp = r.ok;
    } catch {}
    if (daemonUp) ok(`daemon reachable at ${ctx.daemonUrl}`);
    else warn(`daemon not reachable at ${ctx.daemonUrl} (start it with: eos start)`);

    try {
      const s = statSync(home);
      if (s.isDirectory()) ok(`home dir exists: ${home}`);
      else warn(`home dir is not a directory: ${home}`);
    } catch { warn(`home dir missing: ${home}`); }

    try {
      const s = statSync(ctx.config.daemon.dbFile);
      const mb = (s.size / (1024 * 1024)).toFixed(1);
      ok(`state.db size: ${mb} MB`);
      if (s.size > 500 * 1024 * 1024) warn(`state.db is large (>500MB); consider archiving old workers`);
    } catch { warn(`state.db missing: ${ctx.config.daemon.dbFile}`); }

    try {
      let total = 0;
      for (const f of readdirSync(ctx.config.daemon.logDir)) {
        try { total += statSync(join(ctx.config.daemon.logDir, f)).size; } catch {}
      }
      const mb = (total / (1024 * 1024)).toFixed(1);
      ok(`logs dir size: ${mb} MB`);
      if (total > 1024 * 1024 * 1024) warn(`logs dir >1GB — rotate or clean old worker logs`);
    } catch {}

    try {
      const out = execSync(`pgrep -f "eos-" 2>/dev/null || true`, { encoding: "utf8" });
      const pids = out.split(/\s+/).filter(Boolean);
      if (daemonUp) {
        const ws = await fetch(`${ctx.daemonUrl}/workers`).then((r) => r.json()) as Array<{ pid?: number }>;
        const known = new Set(ws.map((w) => w.pid).filter((x): x is number => typeof x === "number"));
        const orphans = pids.map(Number).filter((p) => !known.has(p));
        if (orphans.length > 0) warn(`${orphans.length} orphan eos-* processes (pids: ${orphans.slice(0, 5).join(", ")}...)`);
        else ok(`no orphan eos-* processes`);
      } else if (pids.length > 0) {
        warn(`${pids.length} eos-* processes running but daemon is down — likely orphans`);
      }
    } catch {}

    if (daemonUp) {
      try {
        const pending = await fetch(`${ctx.daemonUrl}/pending`).then((r) => r.json()) as Array<{ expires_at: number }>;
        const now = Date.now();
        const stuck = pending.filter((p) => p.expires_at < now).length;
        if (stuck > 0) warn(`${stuck} pending permission(s) past TTL — daemon should have swept these`);
        else ok(`pending permissions clean (${pending.length} active, none expired)`);
      } catch {}
    }

    console.log(`\n${issues.length === 0 ? "all good." : `${issues.length} issue(s) to review.`}`);
    process.exit(issues.length === 0 ? 0 : 1);
  },
};
