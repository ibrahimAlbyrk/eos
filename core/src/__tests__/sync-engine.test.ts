import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SyncEngine } from "../services/SyncEngine.ts";
import type { SyncDomain, SyncItem } from "../ports/SyncDomain.ts";
import type { SyncLocalState } from "../ports/SyncStateStore.ts";
import type { SyncPutResult, SyncVault, SyncVaultEntry } from "../ports/SyncVault.ts";
import type { SyncCrypto } from "../ports/SyncCrypto.ts";
import type { Logger } from "../ports/Logger.ts";

// The relay vault: latest blob per key, one seq per vault, compare-and-swap writes.
class FakeVault implements SyncVault {
  head = 0;
  readonly records = new Map<string, SyncVaultEntry>();
  async changes(since: number) {
    const entries = [...this.records.values()].filter((e) => e.seq > since).sort((a, b) => a.seq - b.seq);
    return { head: this.head, entries, more: false };
  }
  async put(key: string, baseSeq: number, data: Uint8Array): Promise<SyncPutResult> {
    const cur = this.records.get(key);
    if ((cur?.seq ?? 0) !== baseSeq) return { ok: false, entry: cur! };
    const seq = ++this.head;
    this.records.set(key, { key, seq, data });
    return { ok: true, seq };
  }
}

// Readable on purpose: the engine treats seal/open as opaque, tests read the blobs.
const crypto: SyncCrypto = {
  recordKey: (domain, id) => `${domain}/${id}`,
  seal: (_k, p) => p,
  open: (_k, s) => s,
  hash: (t) => t,
};

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };

class MapDomain implements SyncDomain {
  readonly name = "memory" as const;
  readonly rows = new Map<string, { data: unknown; updatedAt?: number }>();
  failApply = false;
  async list(): Promise<SyncItem[]> {
    return [...this.rows].map(([id, r]) => ({ id, ...r }));
  }
  async get(id: string): Promise<SyncItem | null> {
    const r = this.rows.get(id);
    return r ? { id, ...r } : null;
  }
  async apply(id: string, data: unknown) {
    if (this.failApply) throw new Error("bad data");
    this.rows.set(id, { data, updatedAt: (data as { at?: number }).at });
  }
  async remove(id: string) {
    this.rows.delete(id);
  }
}

function mac(vault: FakeVault, device: string) {
  const domain = new MapDomain();
  let saved: SyncLocalState = { cursor: 0, index: {} };
  const conflicts: { id: string; data: unknown }[] = [];
  let now = 1000;
  const make = () => new SyncEngine({
    vault,
    crypto,
    state: {
      load: () => saved,
      save: (s) => { saved = s; },
      saveConflict: (_d, id, data) => { conflicts.push({ id, data }); },
    },
    domains: [domain],
    clock: { now: () => now },
    device,
    log: quiet,
  });
  return { domain, conflicts, engine: make(), restart: make, tick: (ms: number) => { now += ms; } };
}

describe("SyncEngine", () => {
  it("carries a new record from one Mac to the other", async () => {
    const vault = new FakeVault();
    const a = mac(vault, "air");
    const b = mac(vault, "pro");
    a.domain.rows.set("um-1", { data: { text: "pnpm" }, updatedAt: 5 });
    assert.deepEqual(await a.engine.sync(), { pulled: 0, pushed: 1, conflicts: 0 });
    assert.deepEqual(await b.engine.sync(), { pulled: 1, pushed: 0, conflicts: 0 });
    assert.deepEqual(b.domain.rows.get("um-1")?.data, { text: "pnpm" });
    assert.deepEqual(b.engine.counts(), { memory: 1 });
  });

  it("does not push back what it just applied", async () => {
    const vault = new FakeVault();
    const a = mac(vault, "air");
    const b = mac(vault, "pro");
    a.domain.rows.set("um-1", { data: { text: "x" } });
    await a.engine.sync();
    await b.engine.sync();
    const head = vault.head;
    assert.deepEqual(await b.engine.sync(), { pulled: 0, pushed: 0, conflicts: 0 });
    assert.deepEqual(await a.engine.sync(), { pulled: 0, pushed: 0, conflicts: 0 });
    assert.equal(vault.head, head);
  });

  it("propagates edits and deletes", async () => {
    const vault = new FakeVault();
    const a = mac(vault, "air");
    const b = mac(vault, "pro");
    a.domain.rows.set("um-1", { data: { text: "v1" } });
    await a.engine.sync();
    await b.engine.sync();
    b.domain.rows.set("um-1", { data: { text: "v2" } });
    await b.engine.sync();
    await a.engine.sync();
    assert.deepEqual(a.domain.rows.get("um-1")?.data, { text: "v2" });
    a.domain.rows.delete("um-1");
    await a.engine.sync();
    await b.engine.sync();
    assert.equal(b.domain.rows.has("um-1"), false);
    assert.deepEqual(b.engine.counts(), { memory: 0 });
  });

  it("a Mac that was off catches up from the vault alone", async () => {
    const vault = new FakeVault();
    const a = mac(vault, "air");
    for (const id of ["um-1", "um-2", "um-3"]) {
      a.domain.rows.set(id, { data: { id } });
      await a.engine.sync();
    }
    a.domain.rows.delete("um-2");
    await a.engine.sync();
    const b = mac(vault, "pro");
    await b.engine.sync();
    assert.deepEqual([...b.domain.rows.keys()].sort(), ["um-1", "um-3"]);
  });

  it("on a concurrent edit the newer one wins and the other is kept as a conflict", async () => {
    const vault = new FakeVault();
    const a = mac(vault, "air");
    const b = mac(vault, "pro");
    a.domain.rows.set("um-1", { data: { text: "base" }, updatedAt: 10 });
    await a.engine.sync();
    await b.engine.sync();
    a.domain.rows.set("um-1", { data: { text: "air edit", at: 20 }, updatedAt: 20 });
    b.domain.rows.set("um-1", { data: { text: "pro edit", at: 30 }, updatedAt: 30 });
    await a.engine.sync();
    const r = await b.engine.sync();
    assert.equal(r.conflicts, 1);
    assert.deepEqual(b.domain.rows.get("um-1")?.data, { text: "pro edit", at: 30 });
    assert.deepEqual(b.conflicts, [{ id: "um-1", data: { text: "air edit", at: 20 } }]);
    await a.engine.sync();
    assert.deepEqual(a.domain.rows.get("um-1")?.data, { text: "pro edit", at: 30 });
  });

  it("an older local edit loses to the vault's newer one", async () => {
    const vault = new FakeVault();
    const a = mac(vault, "air");
    const b = mac(vault, "pro");
    a.domain.rows.set("um-1", { data: { text: "base" }, updatedAt: 10 });
    await a.engine.sync();
    await b.engine.sync();
    b.domain.rows.set("um-1", { data: { text: "pro edit", at: 20 }, updatedAt: 20 });
    a.domain.rows.set("um-1", { data: { text: "air edit", at: 30 }, updatedAt: 30 });
    await a.engine.sync();
    await b.engine.sync();
    assert.deepEqual(b.domain.rows.get("um-1")?.data, { text: "air edit", at: 30 });
    assert.deepEqual(b.conflicts, [{ id: "um-1", data: { text: "pro edit", at: 20 } }]);
  });

  it("joining adopts the account's copy and keeps this Mac's aside", async () => {
    const vault = new FakeVault();
    const a = mac(vault, "air");
    a.domain.rows.set("style", { data: "terse", updatedAt: 1 });
    await a.engine.sync();
    const b = mac(vault, "pro");
    b.domain.rows.set("style", { data: "thorough", updatedAt: 999 });
    b.domain.rows.set("um-9", { data: { text: "only on pro" } });
    await b.engine.sync();
    assert.equal(b.domain.rows.get("style")?.data, "terse");
    assert.deepEqual(b.conflicts, [{ id: "style", data: "thorough" }]);
    await a.engine.sync();
    assert.deepEqual(a.domain.rows.get("um-9")?.data, { text: "only on pro" });
  });

  it("identical content on both sides is not a conflict", async () => {
    const vault = new FakeVault();
    const a = mac(vault, "air");
    a.domain.rows.set("style", { data: "terse" });
    await a.engine.sync();
    const b = mac(vault, "pro");
    b.domain.rows.set("style", { data: "terse" });
    const r = await b.engine.sync();
    assert.deepEqual(r, { pulled: 0, pushed: 0, conflicts: 0 });
    assert.deepEqual(b.conflicts, []);
  });

  it("a record its domain refuses is kept as a conflict, not retried forever", async () => {
    const vault = new FakeVault();
    const a = mac(vault, "air");
    const b = mac(vault, "pro");
    a.domain.rows.set("um-1", { data: { text: "x" } });
    await a.engine.sync();
    b.domain.failApply = true;
    await b.engine.sync();
    assert.equal(b.conflicts.length, 1);
    b.domain.failApply = false;
    assert.deepEqual(await b.engine.sync(), { pulled: 0, pushed: 0, conflicts: 0 });
  });

  it("picks up where it left off after a restart", async () => {
    const vault = new FakeVault();
    const a = mac(vault, "air");
    const b = mac(vault, "pro");
    a.domain.rows.set("um-1", { data: { text: "x" } });
    await a.engine.sync();
    await b.engine.sync();
    const again = b.restart();
    assert.deepEqual(await again.sync(), { pulled: 0, pushed: 0, conflicts: 0 });
  });

  it("concurrent callers share one pass and a late ask runs once more", async () => {
    const vault = new FakeVault();
    const a = mac(vault, "air");
    a.domain.rows.set("um-1", { data: 1 });
    const first = a.engine.sync();
    a.domain.rows.set("um-2", { data: 2 });
    const second = a.engine.sync();
    assert.equal(first, second);
    await first;
    assert.equal(vault.records.size, 2);
  });
});
