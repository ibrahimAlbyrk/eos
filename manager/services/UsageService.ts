// UsageService — the cache + rate-floor in front of the subscription usage
// providers. The upstream Claude endpoint 429s aggressively, so at most one
// upstream call is made per MIN_INTERVAL_MS: inside that window every request
// (including a manual refresh) is served from the last snapshot. A per-provider
// fetch failure is caught and surfaced in errors[] — one provider's outage never
// fails the whole response — and the provider's last good snapshot keeps being
// served (marked `stale`) while it retries with a growing backoff. The last good
// snapshots are saved so they survive a daemon restart; only "not signed in"
// (NoUsageAccountError) drops them. Every upstream round-trip is handed to
// onChange (the usage:change topic), so open surfaces move to the new numbers live.

import type { ProviderUsage, UsageResponse } from "../../contracts/src/usage.ts";
import {
  NoUsageAccountError, usageKey, type SubscriptionUsageProvider, type UsageSnapshotStore,
} from "../../core/src/ports/SubscriptionUsageProvider.ts";
import type { Clock } from "../../core/src/ports/Clock.ts";
import { errMsg } from "../../contracts/src/util.ts";

const MIN_INTERVAL_MS = 180_000;
const MAX_BACKOFF_MS = 15 * 60_000;

export interface UsageServiceDeps {
  /** Read on every fetch, so a sign-in added or removed is picked up. */
  providers: SubscriptionUsageProvider[] | (() => SubscriptionUsageProvider[]);
  clock: Clock;
  minIntervalMs?: number;
  store?: UsageSnapshotStore;
  onChange?: (usage: UsageResponse) => void;
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
    for (const snap of deps.store?.load() ?? []) this.stateOf(usageKey(snap.provider, snap.loginId)).last = snap;
  }

  // The last good snapshot of every current provider, without fetching.
  peek(): ProviderUsage[] {
    return this.providers().flatMap((p) => this.states.get(p.id)?.last ?? []);
  }

  // What is held now, without waiting on upstream: past the floor, a refresh
  // starts in the background and arrives through onChange. Only with nothing
  // held yet (never fetched, no saved snapshot) does it wait for the fetch.
  async current(): Promise<UsageResponse> {
    const held = this.cache ?? (this.peek().length ? this.response() : null);
    if (!held) return this.getUsage();
    // A no-op inside the floor; a failed round-trip keeps the last snapshot.
    this.getUsage().catch(() => {});
    return held;
  }

  // A sign-in was added or removed: what is held answers for the old ones, so
  // fetch now, past the floor, and hand the result to onChange. A fetch already
  // under way read the old sign-ins too, so this one runs after it.
  invalidate(): void {
    const prior = this.inflight ?? Promise.resolve();
    prior.catch(() => {}).then(() => {
      this.cache = null;
      return this.getUsage();
    }).catch(() => {});
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
    let changed = false;
    for (const p of this.providers()) {
      const s = this.stateOf(p.id);
      if (now >= s.retryAt) changed = (await this.refresh(p, s, now)) || changed;
    }
    if (changed) this.save();
    this.lastFetchAt = now;
    this.cache = this.response();
    this.deps.onChange?.(this.cache);
    return this.cache;
  }

  private response(): UsageResponse {
    const providers: UsageResponse["providers"] = [];
    const errors: NonNullable<UsageResponse["errors"]> = [];
    for (const p of this.providers()) {
      const s = this.states.get(p.id);
      if (s?.last) providers.push(s.error ? { ...s.last, stale: true } : s.last);
      if (s?.error) errors.push({ provider: p.id, reason: s.error });
    }
    return errors.length ? { providers, errors } : { providers };
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

  private providers(): SubscriptionUsageProvider[] {
    return typeof this.deps.providers === "function" ? this.deps.providers() : this.deps.providers;
  }

  private stateOf(id: string): ProviderState {
    let s = this.states.get(id);
    if (!s) {
      s = { last: null, error: null, failures: 0, retryAt: 0 };
      this.states.set(id, s);
    }
    return s;
  }

  private save(): void {
    const current = new Set(this.providers().map((p) => p.id));
    const snapshots = [...this.states].flatMap(([id, s]) => (s.last && current.has(id) ? [s.last] : []));
    // Best effort: a failed write only costs the snapshot across a restart.
    try { this.deps.store?.save(snapshots); } catch { /* ignore */ }
  }
}
