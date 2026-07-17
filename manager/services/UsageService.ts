// UsageService — the cache + rate-floor in front of the subscription usage
// providers. The upstream Claude endpoint 429s aggressively, so at most one
// upstream call is made per MIN_INTERVAL_MS: inside that window every request
// (including a manual refresh) is served from the last snapshot. A per-provider
// fetch failure is caught and surfaced in errors[] — one provider's outage never
// fails the whole response.

import type { UsageResponse } from "../../contracts/src/usage.ts";
import type { SubscriptionUsageProvider } from "../../core/src/ports/SubscriptionUsageProvider.ts";
import type { Clock } from "../../core/src/ports/Clock.ts";
import { errMsg } from "../../contracts/src/util.ts";

const MIN_INTERVAL_MS = 180_000;

export interface UsageServiceDeps {
  providers: SubscriptionUsageProvider[];
  clock: Clock;
  minIntervalMs?: number;
}

export class UsageService {
  private cache: UsageResponse | null = null;
  private lastFetchAt = 0;
  private inflight: Promise<UsageResponse> | null = null;
  private readonly floorMs: number;
  private readonly deps: UsageServiceDeps;

  constructor(deps: UsageServiceDeps) {
    this.deps = deps;
    this.floorMs = deps.minIntervalMs ?? MIN_INTERVAL_MS;
  }

  // Serve cache within the floor; otherwise fetch fresh. A refresh is honored the
  // same way — it can't bust the floor (that's what protects the 429ing endpoint).
  async getUsage(): Promise<UsageResponse> {
    const now = this.deps.clock.now();
    if (this.cache && now - this.lastFetchAt < this.floorMs) return this.cache;
    // Collapse concurrent refreshes onto one upstream round-trip.
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchAll(now).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async fetchAll(now: number): Promise<UsageResponse> {
    const providers: UsageResponse["providers"] = [];
    const errors: NonNullable<UsageResponse["errors"]> = [];
    for (const p of this.deps.providers) {
      try {
        providers.push(await p.fetchUsage());
      } catch (e) {
        errors.push({ provider: p.id, reason: errMsg(e) });
      }
    }
    this.lastFetchAt = now;
    this.cache = errors.length ? { providers, errors } : { providers };
    return this.cache;
  }
}
