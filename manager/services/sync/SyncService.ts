// SyncService — the daemon side of Settings › Sync: owns the sync key, runs the
// engine and keeps this Mac caught up. A pass runs on start, after a local change
// (debounced), when the vault's long poll reports another Mac's write, and every
// minute for the hand-edited folders that have no change event. Failures back off
// and surface as the status error; the next pass retries everything.

import type { EventBus } from "../../../core/src/ports/EventBus.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";
import type { SyncDomain } from "../../../core/src/ports/SyncDomain.ts";
import type { SyncVault } from "../../../core/src/ports/SyncVault.ts";
import { SyncEngine } from "../../../core/src/services/SyncEngine.ts";
import { HttpSyncVault } from "../../../infra/src/sync/HttpSyncVault.ts";
import { deriveSyncKeys, formatSyncKey, newSyncIdentity, parseSyncKey, type SyncIdentity } from "../../../infra/src/sync/sync-key.ts";
import type { FileSyncIdentityStore, FileSyncStateStore } from "../../../infra/src/sync/stores.ts";
import { ValidationError } from "../../../core/src/errors/index.ts";
import type { SyncStatusResponse } from "../../../contracts/src/sync.ts";

const LONG_POLL_MS = 25_000;
const LOCAL_DEBOUNCE_MS = 1500;
const SWEEP_MS = 60_000;
const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];

export interface SyncServiceDeps {
  readonly identities: FileSyncIdentityStore;
  readonly state: FileSyncStateStore;
  readonly domains: readonly SyncDomain[];
  // The relay a new account is created on (config.peer.relayUrl ?? remote relay).
  readonly relayUrl: () => string | null;
  readonly device: string;
  readonly bus: Pick<EventBus, "publish">;
  readonly log: Logger;
  readonly now: () => number;
  // Tests swap the network out.
  readonly vaultFor?: (id: SyncIdentity) => SyncVault;
}

interface Session {
  readonly identity: SyncIdentity;
  readonly vault: SyncVault;
  readonly engine: SyncEngine;
  readonly abort: AbortController;
  readonly timers: ReturnType<typeof setInterval>[];
}

export class SyncService {
  private readonly deps: SyncServiceDeps;
  private session: Session | null = null;
  private syncing = false;
  private lastSyncAt: number | null = null;
  private error: string | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: SyncServiceDeps) {
    this.deps = deps;
  }

  start(): void {
    const id = this.deps.identities.load();
    if (id) this.open(id);
  }

  stop(): void {
    this.close();
  }

  status(): SyncStatusResponse {
    const s = this.session;
    return {
      phase: !s ? "off" : this.syncing ? "syncing" : this.error ? "error" : "idle",
      relay: s ? hostOf(s.identity.relayUrl) : null,
      lastSyncAt: this.lastSyncAt,
      error: s ? this.error : null,
      counts: s ? s.engine.counts() : {},
    };
  }

  key(): string | null {
    return this.session ? formatSyncKey(this.session.identity) : null;
  }

  // A new account: this Mac's data becomes its first content.
  create(): SyncStatusResponse {
    const relay = this.deps.relayUrl();
    if (!relay) throw new ValidationError("set up a relay first (Settings › Remote)");
    return this.adopt(newSyncIdentity(relay));
  }

  // Joining: the account's copy wins where both have one; this Mac's is kept aside.
  join(key: string): SyncStatusResponse {
    const id = parseSyncKey(key);
    if (!id) throw new ValidationError("that isn't a sync key");
    return this.adopt(id);
  }

  // This Mac stops syncing; its data stays as it is.
  leave(): SyncStatusResponse {
    this.close();
    this.deps.identities.clear();
    this.deps.state.reset();
    this.lastSyncAt = null;
    this.error = null;
    this.publish();
    return this.status();
  }

  syncNow(): void {
    void this.pass();
  }

  // A local change — pushed once the burst settles.
  noteLocalChange(): void {
    if (!this.session) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.pass();
    }, LOCAL_DEBOUNCE_MS);
    this.debounce.unref?.();
  }

  private adopt(id: SyncIdentity): SyncStatusResponse {
    this.close();
    this.deps.state.reset();
    this.deps.identities.save(id);
    this.lastSyncAt = null;
    this.error = null;
    this.open(id);
    return this.status();
  }

  private open(identity: SyncIdentity): void {
    const keys = deriveSyncKeys(identity.secret);
    const vault = this.deps.vaultFor?.(identity)
      ?? new HttpSyncVault({ relayUrl: identity.relayUrl, vaultId: keys.vaultId, authToken: keys.authToken });
    const engine = new SyncEngine({
      vault,
      crypto: keys.crypto,
      state: this.deps.state,
      domains: this.deps.domains,
      clock: { now: this.deps.now },
      device: this.deps.device,
      log: this.deps.log,
    });
    const sweep = setInterval(() => void this.pass(), SWEEP_MS);
    sweep.unref?.();
    const session: Session = { identity, vault, engine, abort: new AbortController(), timers: [sweep] };
    this.session = session;
    this.publish();
    void this.watch(session);
  }

  private close(): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    s.abort.abort();
    for (const t of s.timers) clearInterval(t);
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
  }

  // Pass, then wait on the vault for another Mac's write; on failure back off and
  // start over with a pass.
  private async watch(session: Session): Promise<void> {
    let failures = 0;
    while (this.session === session) {
      try {
        if (!(await this.pass())) throw new Error(this.error ?? "sync failed");
        failures = 0;
        while (this.session === session) {
          const page = await session.vault.changes(session.engine.position(), LONG_POLL_MS, session.abort.signal);
          if (page.entries.length && !(await this.pass())) break;
        }
      } catch (e) {
        if (this.session !== session) return;
        this.fail(e);
      }
      if (this.session !== session) return;
      const wait = BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)]!;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, wait);
        t.unref?.();
        session.abort.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
      });
    }
  }

  // True when the pass completed.
  private async pass(): Promise<boolean> {
    const session = this.session;
    if (!session) return false;
    this.syncing = true;
    this.publish();
    try {
      const r = await session.engine.sync();
      if (this.session !== session) return false;
      this.lastSyncAt = this.deps.now();
      this.error = null;
      if (r.pulled || r.pushed || r.conflicts) this.deps.log.info("sync: pass", { ...r });
      return true;
    } catch (e) {
      if (this.session === session) this.fail(e);
      return false;
    } finally {
      this.syncing = false;
      if (this.session === session) this.publish();
    }
  }

  private fail(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    if (message !== this.error) this.deps.log.warn("sync: failed", { error: message });
    this.error = message;
    this.publish();
  }

  private publish(): void {
    this.deps.bus.publish("sync:change", this.status());
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
