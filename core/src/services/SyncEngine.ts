// SyncEngine — one sync pass over every domain: pull what other Macs pushed to the
// vault, then push what changed here. Plan: docs/sync/00-SYNC-PLAN.md.
//
// The index remembers, per record, the vault seq this Mac last matched and the local
// record's hash at that point. A local hash that differs is a change to push; a
// record that vanished locally is a delete. Applying a remote change re-indexes the
// local result, so the change event it fires is not pushed back.
//
// Conflicts (the same record changed on two Macs before either synced): the newer
// `changedAt` wins and the loser is kept through SyncStateStore.saveConflict. A local
// record this Mac never synced counts as oldest — joining adopts the account's copy.

import type { Clock } from "../ports/Clock.ts";
import type { Logger } from "../ports/Logger.ts";
import type { SyncCrypto } from "../ports/SyncCrypto.ts";
import type { SyncDomain, SyncItem } from "../ports/SyncDomain.ts";
import type { SyncIndexEntry, SyncStateStore } from "../ports/SyncStateStore.ts";
import type { SyncVault, SyncVaultEntry } from "../ports/SyncVault.ts";
import { stableStringify, syncIndexKey } from "../domain/sync.ts";
import { SyncEnvelopeSchema, type SyncEnvelope } from "../../../contracts/src/sync.ts";

const MAX_PUSH_ATTEMPTS = 3;

export interface SyncEngineDeps {
  readonly vault: SyncVault;
  readonly crypto: SyncCrypto;
  readonly state: SyncStateStore;
  readonly domains: readonly SyncDomain[];
  readonly clock: Clock;
  // Stamped on what this Mac pushes (its peer deviceId).
  readonly device: string;
  readonly log: Logger;
}

export interface SyncPassResult {
  pulled: number;
  pushed: number;
  conflicts: number;
}

export class SyncEngine {
  private readonly deps: SyncEngineDeps;
  private readonly byName: Map<string, SyncDomain>;
  private cursor: number;
  private index: Record<string, SyncIndexEntry>;
  private inFlight: Promise<SyncPassResult> | null = null;
  private again = false;

  constructor(deps: SyncEngineDeps) {
    this.deps = deps;
    this.byName = new Map(deps.domains.map((d) => [d.name, d]));
    const saved = deps.state.load();
    this.cursor = saved.cursor;
    this.index = { ...saved.index };
  }

  // The last vault seq this Mac has seen — where a wait for new writes starts.
  position(): number {
    return this.cursor;
  }

  // Live records per domain, as of the last pass.
  counts(): Record<string, number> {
    const out: Record<string, number> = Object.fromEntries(this.deps.domains.map((d) => [d.name, 0]));
    for (const [key, entry] of Object.entries(this.index)) {
      const domain = key.slice(0, key.indexOf("/"));
      if (entry.hash !== null && domain in out) out[domain]! += 1;
    }
    return out;
  }

  // Callers share the pass in flight; asking again during one runs one more after it,
  // so a change made mid-pass is never left behind.
  sync(): Promise<SyncPassResult> {
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    this.inFlight = (async () => {
      const total: SyncPassResult = { pulled: 0, pushed: 0, conflicts: 0 };
      try {
        do {
          this.again = false;
          await this.pass(total);
        } while (this.again);
      } finally {
        this.inFlight = null;
      }
      return total;
    })();
    return this.inFlight;
  }

  private async pass(tally: SyncPassResult): Promise<void> {
    try {
      await this.pull(tally);
      for (const domain of this.deps.domains) await this.pushDomain(domain, tally);
    } finally {
      this.deps.state.save({ cursor: this.cursor, index: this.index });
    }
  }

  private async pull(tally: SyncPassResult): Promise<void> {
    for (;;) {
      const page = await this.deps.vault.changes(this.cursor, 0);
      for (const entry of page.entries) {
        await this.receive(entry, tally);
        this.cursor = Math.max(this.cursor, entry.seq);
      }
      if (!page.more || !page.entries.length) return;
    }
  }

  private async pushDomain(domain: SyncDomain, tally: SyncPassResult): Promise<void> {
    const seen = new Set<string>();
    for (const item of await domain.list()) {
      const key = syncIndexKey(domain.name, item.id);
      seen.add(key);
      if (this.index[key]?.hash !== this.hashOf(item)) await this.send(domain, item.id, item, tally);
    }
    const prefix = `${domain.name}/`;
    for (const [key, entry] of Object.entries(this.index)) {
      if (key.startsWith(prefix) && !seen.has(key) && entry.hash !== null) {
        await this.send(domain, key.slice(prefix.length), null, tally);
      }
    }
  }

  private async send(domain: SyncDomain, id: string, item: SyncItem | null, tally: SyncPassResult): Promise<void> {
    const key = syncIndexKey(domain.name, id);
    const recordKey = this.deps.crypto.recordKey(domain.name, id);
    let current = item;
    for (let attempt = 0; attempt < MAX_PUSH_ATTEMPTS; attempt++) {
      const envelope: SyncEnvelope = current
        ? { v: 1, domain: domain.name, id, changedAt: current.updatedAt ?? this.deps.clock.now(), device: this.deps.device, data: current.data }
        : { v: 1, domain: domain.name, id, changedAt: this.deps.clock.now(), device: this.deps.device, deleted: true };
      const sealed = this.deps.crypto.seal(recordKey, new TextEncoder().encode(JSON.stringify(envelope)));
      const res = await this.deps.vault.put(recordKey, this.index[key]?.seq ?? 0, sealed);
      if (res.ok) {
        this.index[key] = { seq: res.seq, hash: this.hashOf(current) };
        tally.pushed += 1;
        return;
      }
      await this.receive(res.entry, tally);
      // An unreadable blob leaves the index behind it — ours replaces it.
      if ((this.index[key]?.seq ?? 0) < res.entry.seq) this.index[key] = { seq: res.entry.seq, hash: null };
      current = await domain.get(id);
      if (this.index[key]?.hash === this.hashOf(current)) return;
    }
    this.deps.log.warn("sync: record kept changing under us; retrying next pass", { domain: domain.name, id });
  }

  private async receive(entry: SyncVaultEntry, tally: SyncPassResult): Promise<void> {
    const envelope = this.open(entry);
    if (!envelope) return;
    const domain = this.byName.get(envelope.domain);
    if (!domain) return;
    const key = syncIndexKey(envelope.domain, envelope.id);
    const known = this.index[key];
    if (known && known.seq >= entry.seq) return;

    const local = await domain.get(envelope.id);
    const localHash = this.hashOf(local);
    const remoteHash = envelope.deleted ? null : this.hashOf({ id: envelope.id, data: envelope.data });
    if (localHash === remoteHash) {
      this.index[key] = { seq: entry.seq, hash: localHash };
      return;
    }
    const localChanged = known ? localHash !== known.hash : local !== null;
    if (localChanged) {
      tally.conflicts += 1;
      const localAt = known ? (local?.updatedAt ?? this.deps.clock.now()) : 0;
      if (envelope.changedAt < localAt) {
        // Ours is newer: keep theirs aside and push ours over the seq we just saw.
        if (!envelope.deleted) this.deps.state.saveConflict(envelope.domain, envelope.id, envelope.data);
        this.index[key] = { seq: entry.seq, hash: remoteHash };
        return;
      }
      if (local) this.deps.state.saveConflict(envelope.domain, envelope.id, local.data);
    }

    try {
      if (envelope.deleted) await domain.remove(envelope.id);
      else await domain.apply(envelope.id, envelope.data);
    } catch (e) {
      this.deps.log.warn("sync: could not apply a record; kept as a conflict", {
        domain: envelope.domain, id: envelope.id, error: e instanceof Error ? e.message : String(e),
      });
      if (!envelope.deleted) this.deps.state.saveConflict(envelope.domain, envelope.id, envelope.data);
      this.index[key] = { seq: entry.seq, hash: localHash };
      return;
    }
    this.index[key] = { seq: entry.seq, hash: this.hashOf(await domain.get(envelope.id)) };
    tally.pulled += 1;
  }

  private open(entry: SyncVaultEntry): SyncEnvelope | null {
    try {
      const plain = this.deps.crypto.open(entry.key, entry.data);
      const envelope = SyncEnvelopeSchema.parse(JSON.parse(new TextDecoder().decode(plain)));
      // The key binds the blob to its record; a mismatch is a blob moved between records.
      if (this.deps.crypto.recordKey(envelope.domain, envelope.id) !== entry.key) throw new Error("record key mismatch");
      return envelope;
    } catch (e) {
      this.deps.log.warn("sync: skipped an unreadable record", { seq: entry.seq, error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  private hashOf(item: Pick<SyncItem, "id" | "data"> | null): string | null {
    return item ? this.deps.crypto.hash(stableStringify(item.data)) : null;
  }
}
