// UsageService — the cache + rate-floor in front of the subscription usage
// providers. The upstream Claude endpoint 429s aggressively, so at most one
// upstream call is made per MIN_INTERVAL_MS: inside that window every request
// (including a manual refresh) is served from the last snapshot. A per-provider
// fetch failure is caught and surfaced in errors[] — one provider's outage never
// fails the whole response — and the provider's last good snapshot keeps being
// served (marked `stale`) while it retries with a growing backoff. The last good
// snapshots are saved so they survive a daemon restart; only "not signed in"
// (NoUsageAccountError) drops them.

import type { ProviderUsage, UsageResponse } from "../../contracts/src/usage.ts";
import {
  NoUsageAccountError, type SubscriptionUsageProvider, type UsageSnapshotStore,
} from "../../core/src/ports/SubscriptionUsageProvider.ts";
import type { Clock } from "../../core/src/ports/Clock.ts";
import { errMsg } from "../../contracts/src/util.ts";

const MIN_INTERVAL_MS = 180_000;
const MAX_BACKOFF_MS = 15 * 60_000;

export interface UsageServiceDeps {
  providers: SubscriptionUsageProvider[];
  clock: Clock;
  minIntervalMs?: number;
  store?: UsageSnapshotStore;
}

interface ProviderState {
  last: ProviderUsage | null;
  error: string | null;
  failures: number;
  retryAt: number;
}

export class UsageService {
  private cache: UsageResponse | null = null;
  private lastFetchAt = 0;
  private inflight: Promise<UsageResponse> | null = null;
  private readonly floorMs: number;
  private readonly deps: UsageServiceDeps;
  private readonly states = new Map<string, ProviderState>();

  constructor(deps: UsageServiceDeps) {
    this.deps = deps;
    this.floorMs = deps.minIntervalMs ?? MIN_INTERVAL_MS;
    for (const p of deps.providers) this.states.set(p.id, { last: null, error: null, failures: 0, retryAt: 0 });
    for (const snap of deps.store?.load() ?? []) {
      const s = this.states.get(snap.provider);
      if (s) s.last = snap;
    }
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
    let changed = false;
    for (const p of this.deps.providers) {
      const s = this.states.get(p.id)!;
      if (now >= s.retryAt) changed = (await this.refresh(p, s, now)) || changed;
      if (s.last) providers.push(s.error ? { ...s.last, stale: true } : s.last);
      if (s.error) errors.push({ provider: p.id, reason: s.error });
    }
    if (changed) this.save();
    this.lastFetchAt = now;
    this.cache = errors.length ? { providers, errors } : { providers };
    return this.cache;
  }

  // Fetch one provider into its state; true when its saved snapshot changed.
  private async refresh(p: SubscriptionUsageProvider, s: ProviderState, now: number): Promise<boolean> {
    try {
      s.last = await p.fetchUsage();
      s.error = null;
      s.failures = 0;
      s.retryAt = 0;
      return true;
    } catch (e) {
      s.error = errMsg(e);
      if (e instanceof NoUsageAccountError) {
        const had = s.last !== null;
        s.last = null;
        return had;
      }
      // Back off only while a snapshot covers the gap; with nothing to show,
      // keep retrying at the floor so a fixed sign-in shows up promptly.
      if (s.last) {
        s.failures++;
        s.retryAt = now + Math.min(this.floorMs * 2 ** (s.failures - 1), MAX_BACKOFF_MS);
      }
      return false;
    }
  }

  private save(): void {
    const snapshots = [...this.states.values()].flatMap((s) => (s.last ? [s.last] : []));
    // Best effort: a failed write only costs the snapshot across a restart.
    try { this.deps.store?.save(snapshots); } catch { /* ignore */ }
  }
}
