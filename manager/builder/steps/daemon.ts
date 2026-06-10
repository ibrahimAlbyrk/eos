// The daemon "artifact" is the running process; its stamp lives in /health
// (computed by the daemon itself at boot from the same backendSpec). Restart
// is disruptive — agents get pkilled and recover via session resume — so the
// step warns with the live agent count first.

import { join } from "node:path";

import { HealthResponseSchema } from "../../../contracts/src/http.ts";
import { spawnDaemonDetached, stopDaemonAndOrphans, waitHealthy } from "../../cli/daemon-lifecycle.ts";
import { computeBackendStamp } from "../backend-stamp.ts";
import type { BuildCtx, BuildStep } from "../BuildStep.ts";

function configJsonPath(ctx: BuildCtx): string {
  return join(ctx.eosHome, "config.json");
}

async function fetchSourceStamp(daemonUrl: string): Promise<string | null> {
  try {
    const r = await fetch(`${daemonUrl}/health`);
    if (!r.ok) return null;
    const parsed = HealthResponseSchema.safeParse(await r.json());
    return parsed.success ? parsed.data.sourceStamp : null;
  } catch {
    return null;
  }
}

async function countAgents(daemonUrl: string): Promise<number | null> {
  try {
    const r = await fetch(`${daemonUrl}/workers`);
    if (!r.ok) return null;
    const body: unknown = await r.json();
    if (Array.isArray(body)) return body.length;
    const workers = (body as { workers?: unknown })?.workers;
    return Array.isArray(workers) ? workers.length : null;
  } catch {
    return null;
  }
}

export const daemonStep: BuildStep = {
  id: "daemon",
  verb: { run: "restarting", done: "restarted" },
  missingReason: "daemon down or unstamped",
  desiredStamp: (ctx) => computeBackendStamp(ctx.repoRoot, configJsonPath(ctx)),
  currentStamp: (ctx) => fetchSourceStamp(ctx.daemonUrl),
  async apply(ctx, desired): Promise<void> {
    const agents = await countAgents(ctx.daemonUrl);
    if (agents) ctx.log(`  ${agents} agent(s) will suspend and resume`);
    await stopDaemonAndOrphans(ctx.pidFile);
    spawnDaemonDetached(ctx.repoRoot);
    const body = await waitHealthy(ctx.daemonUrl, 40);
    if (body === null) {
      throw new Error("daemon failed to start — run `eos start -f` for foreground diagnostics");
    }
    const parsed = HealthResponseSchema.safeParse(body);
    const got = parsed.success ? parsed.data.sourceStamp : null;
    // One bounded recheck: apply may race a legitimate source edit.
    if (got !== desired && got !== computeBackendStamp(ctx.repoRoot, configJsonPath(ctx))) {
      throw new Error("daemon restarted but reports a different source stamp — source changed during build? rerun eos build");
    }
  },
};
