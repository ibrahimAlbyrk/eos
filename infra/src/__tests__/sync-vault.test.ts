import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { deriveSyncKeys, formatSyncKey, newSyncIdentity, parseSyncKey } from "../sync/sync-key.ts";
import { HttpSyncVault } from "../sync/HttpSyncVault.ts";
import { FileSyncIdentityStore, FileSyncStateStore } from "../sync/stores.ts";
import { createRelay } from "../../../relay/server.ts";
import { loadConfig } from "../../../relay/config.ts";

async function withRelay(fn: (url: string) => Promise<void>): Promise<void> {
  const { httpServer } = createRelay({ ...loadConfig({}), vaultPath: ":memory:" });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const { port } = httpServer.address() as AddressInfo;
  try {
    await fn(`ws://127.0.0.1:${port}/`);
  } finally {
    await new Promise<void>((r) => httpServer.close(() => r()));
  }
}

describe("sync key", () => {
  it("round-trips through its string form", () => {
    const id = newSyncIdentity("wss://relay.example/");
    const parsed = parseSyncKey(`  ${formatSyncKey(id)}\n`);
    assert.equal(parsed?.relayUrl, "wss://relay.example/");
    assert.deepEqual(parsed?.secret, id.secret);
    assert.equal(parseSyncKey("eos-sync1.abc"), null);
    assert.equal(parseSyncKey(formatSyncKey(id).replace("eos-sync1", "eos-sync2")), null);
  });

  it("seals records so only the same key, for the same record, opens them", () => {
    const keys = deriveSyncKeys(newSyncIdentity("wss://r/").secret);
    const k1 = keys.crypto.recordKey("memory", "um-1");
    const k2 = keys.crypto.recordKey("memory", "um-2");
    assert.match(k1, /^[a-f0-9]{64}$/);
    assert.match(keys.vaultId, /^[a-f0-9]{32}$/);
    const sealed = keys.crypto.seal(k1, new TextEncoder().encode("hello"));
    assert.equal(new TextDecoder().decode(keys.crypto.open(k1, sealed)), "hello");
    assert.throws(() => keys.crypto.open(k2, sealed));
    const other = deriveSyncKeys(newSyncIdentity("wss://r/").secret);
    assert.throws(() => other.crypto.open(k1, sealed));
  });
});

describe("HttpSyncVault against the relay", () => {
  it("writes, conflicts and reads changes", async () => {
    await withRelay(async (url) => {
      const keys = deriveSyncKeys(newSyncIdentity(url).secret);
      const vault = new HttpSyncVault({ relayUrl: url, vaultId: keys.vaultId, authToken: keys.authToken });
      const key = keys.crypto.recordKey("page", "pg-1");
      assert.deepEqual(await vault.put(key, 0, new Uint8Array([1, 2])), { ok: true, seq: 1 });
      const stale = await vault.put(key, 0, new Uint8Array([3]));
      assert.equal(stale.ok, false);
      assert.ok(!stale.ok && stale.entry.seq === 1);
      assert.deepEqual(await vault.put(key, 1, new Uint8Array([4])), { ok: true, seq: 2 });
      const changes = await vault.changes(0, 0);
      assert.equal(changes.head, 2);
      assert.deepEqual(changes.entries.map((e) => [e.seq, [...e.data]]), [[2, [4]]]);
    });
  });

  it("a long poll returns as soon as another Mac writes", async () => {
    await withRelay(async (url) => {
      const keys = deriveSyncKeys(newSyncIdentity(url).secret);
      const vault = new HttpSyncVault({ relayUrl: url, vaultId: keys.vaultId, authToken: keys.authToken });
      const started = Date.now();
      const waiting = vault.changes(0, 10_000);
      setTimeout(() => void vault.put("a".repeat(64), 0, new Uint8Array([9])), 100);
      const got = await waiting;
      assert.equal(got.entries.length, 1);
      assert.ok(Date.now() - started < 5000);
    });
  });

  it("refuses a different key on the same vault", async () => {
    await withRelay(async (url) => {
      const keys = deriveSyncKeys(newSyncIdentity(url).secret);
      await new HttpSyncVault({ relayUrl: url, vaultId: keys.vaultId, authToken: keys.authToken }).changes(0, 0);
      const imposter = new HttpSyncVault({ relayUrl: url, vaultId: keys.vaultId, authToken: "x".repeat(43) });
      await assert.rejects(imposter.changes(0, 0), /403/);
    });
  });
});

describe("sync stores", () => {
  it("keep state, conflicts and an owner-only identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "eos-sync-"));
    const state = new FileSyncStateStore(dir);
    assert.deepEqual(state.load(), { cursor: 0, index: {} });
    state.save({ cursor: 7, index: { "memory/um-1": { seq: 7, hash: "h" } } });
    assert.deepEqual(state.load(), { cursor: 7, index: { "memory/um-1": { seq: 7, hash: "h" } } });
    state.saveConflict("worker", "../evil", { md: "x" });
    assert.equal(readdirSync(join(dir, "conflicts", "worker")).length, 1);
    state.reset();
    assert.deepEqual(state.load(), { cursor: 0, index: {} });

    const ids = new FileSyncIdentityStore(dir);
    assert.equal(ids.load(), null);
    const id = newSyncIdentity("wss://r/");
    ids.save(id);
    assert.deepEqual(ids.load(), id);
    assert.equal(statSync(join(dir, "identity.json")).mode & 0o777, 0o600);
    ids.clear();
    assert.equal(ids.load(), null);
  });
});
