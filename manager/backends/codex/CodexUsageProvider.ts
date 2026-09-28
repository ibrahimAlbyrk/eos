// ChatGPT plan usage for the Usage pane — the Codex app-server's
// account/rateLimits/read, mapped onto the provider-neutral ProviderUsage. Codex
// reports up to two rolling windows (primary / secondary) with their length in
// minutes; each lands in the slot of the same length — the 5-hour session or the
// weekly limit — so the pane renders them exactly like Claude's.

import type { SubscriptionUsageProvider } from "../../../core/src/ports/SubscriptionUsageProvider.ts";
import type { ProviderUsage, UsageWindow } from "../../../contracts/src/usage.ts";
import type { AppServerClient, AppServerOptions } from "./AppServerClient.ts";

// The quiet "nothing to show" reason — the UI hides it rather than erroring.
export const CODEX_NOT_SIGNED_IN = "Not signed in to ChatGPT.";

const SESSION_MAX_MINS = 6 * 60; // Codex's short window is 5 h; anything longer is the weekly one

const PLAN_LABELS: Record<string, string> = { prolite: "Pro Lite" };

interface RateLimitWindow { usedPercent?: number; windowDurationMins?: number | null; resetsAt?: number | null }
interface RateLimitSnapshot { primary?: RateLimitWindow | null; secondary?: RateLimitWindow | null; planType?: string | null }

function toWindow(w: RateLimitWindow): UsageWindow | null {
  if (typeof w.usedPercent !== "number" || typeof w.resetsAt !== "number") return null;
  return { utilization: Math.max(0, Math.min(100, w.usedPercent)), resetsAt: new Date(w.resetsAt * 1000).toISOString() };
}

export function codexUsageWindows(snapshot: RateLimitSnapshot | null | undefined): ProviderUsage["windows"] {
  const windows: ProviderUsage["windows"] = { fiveHour: null, sevenDay: null };
  for (const raw of [snapshot?.primary, snapshot?.secondary]) {
    if (!raw) continue;
    const win = toWindow(raw);
    if (!win) continue;
    const mins = raw.windowDurationMins ?? 0;
    if (mins > 0 && mins <= SESSION_MAX_MINS) windows.fiveHour ??= win;
    else windows.sevenDay ??= win;
  }
  return windows;
}

export function codexPlanLabel(plan: string | null | undefined): string | undefined {
  if (!plan || plan === "unknown") return undefined;
  return PLAN_LABELS[plan] ?? `${plan[0].toUpperCase()}${plan.slice(1)}`;
}

export interface CodexUsageProviderDeps {
  binary: string | null;
  env(): Record<string, string | undefined>;
  /** Is there a ChatGPT login to read usage for (readCodexLogin)? */
  signedIn(): boolean;
  open(opts: AppServerOptions): Promise<AppServerClient>;
  now?(): Date;
}

export function createCodexUsageProvider(deps: CodexUsageProviderDeps): SubscriptionUsageProvider {
  return {
    id: "codex",
    async fetchUsage(): Promise<ProviderUsage> {
      if (!deps.binary || !deps.signedIn()) throw new Error(CODEX_NOT_SIGNED_IN);
      const client = await deps.open({ binary: deps.binary, args: ["-c", "notify=[]"], env: deps.env() });
      try {
        const res = await client.request<{ rateLimits?: RateLimitSnapshot | null }>("account/rateLimits/read", { excludeResetCreditDetails: true });
        const plan = codexPlanLabel(res.rateLimits?.planType);
        return {
          provider: "codex",
          ...(plan ? { plan } : {}),
          windows: codexUsageWindows(res.rateLimits),
          fetchedAt: (deps.now?.() ?? new Date()).toISOString(),
        };
      } finally {
        client.close();
      }
    },
  };
}
