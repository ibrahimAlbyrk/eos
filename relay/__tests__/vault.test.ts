import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { VaultStore } from "../vault/VaultStore.ts";
import { createRelay } from "../server.ts";
import { loadConfig } from "../config.ts";
import { handleVault, type VaultWaiters } from "../vault/routes.ts";

const VAULT = "a".repeat(32);
const OTHER = "b".repeat(32);
const KEY = "c".repeat(64);
const KEY2 = "d".repeat(64);
const TOKEN = "token-0123456789abcdef";

function store(limits: Partial<{ maxVaults: number; maxVaultBytes: number }> = {}): VaultStore {
  return new VaultStore(":memory:", { maxVaults: 16, maxVaultBytes: 1024, ...limits });
}

test("put is a compare-and-swap per key, seq is per vault", () => {
  const s = store();
  assert.equal(s.authorize(VAULT, TOKEN), "ok");
  assert.deepEqual(s.put(VAULT, KEY, 0, Buffer.from("one")), { ok: true, seq: 1 });
  assert.deepEqual(s.put(VAULT, KEY2, 0, Buffer.from("two")), { ok: true, seq: 2 });

  const stale = s.put(VAULT, KEY, 0, Buffer.from("lost"));
  assert.equal(stale.ok, false);
  assert.ok(!stale.ok && stale.reason === "conflict" && stale.entry);
  assert.equal(stale.entry.seq, 1);
  assert.equal(stale.entry.data.toString(), "one");

  assert.deepEqual(s.put(VAULT, KEY, 1, Buffer.from("one-v2")), { ok: true, seq: 3 });
  // a key the vault never saw only accepts baseSeq 0
  const ghost = s.put(VAULT, "e".repeat(64), 5, Buffer.from("x"));
  assert.ok(!ghost.ok && ghost.reason === "conflict" && ghost.entry === null);
  s.close();
});

test("changes pages in seq order from `since`", () => {
  const s = store();
  s.authorize(VAULT, TOKEN);
  assert.deepEqual(s.changes(VAULT, 0, 10), { head: 0, entries: [], more: false });
  for (let i = 0; i < 5; i++) s.put(VAULT, String(i).repeat(64), 0, Buffer.from(`r${i}`));
  s.put(VAULT, "0".repeat(64), 1, Buffer.from("r0-v2"));

  const first = s.changes(VAULT, 0, 2);
  assert.equal(first.head, 6);
  assert.deepEqual(first.entries.map((e) => e.seq), [2, 3]);
  assert.equal(first.more, true);
  const rest = s.changes(VAULT, 3, 10);
  assert.deepEqual(rest.entries.map((e) => [e.seq, e.data.toString()]), [[4, "r3"], [5, "r4"], [6, "r0-v2"]]);
  assert.equal(rest.more, false);
  assert.deepEqual(s.changes(OTHER, 0, 10), { head: 0, entries: [], more: false });
  s.close();
});

test("authorize pins the first token, refuses others and new vaults past the cap", () => {
  const s = store({ maxVaults: 1 });
  assert.equal(s.authorize(VAULT, TOKEN), "ok");
  assert.equal(s.authorize(VAULT, TOKEN), "ok");
  assert.equal(s.authorize(VAULT, "someone-else-0123456"), "forbidden");
  assert.equal(s.authorize(OTHER, TOKEN), "full");
  s.close();
});

test("put past the vault quota is refused, replacing counts the delta", () => {
  const s = store({ maxVaultBytes: 10 });
  s.authorize(VAULT, TOKEN);
  assert.equal(s.put(VAULT, KEY, 0, Buffer.alloc(8)).ok, true);
  const over = s.put(VAULT, KEY2, 0, Buffer.alloc(3));
  assert.ok(!over.ok && over.reason === "quota");
  // the refused put left nothing behind
  assert.equal(s.changes(VAULT, 0, 10).head, 1);
  assert.deepEqual(s.put(VAULT, KEY, 1, Buffer.alloc(10)), { ok: true, seq: 2 });
  s.close();
});

test("the store survives a reopen", (t) => {
  const path = `${process.env.TMPDIR ?? "/tmp"}/eos-vault-${process.pid}-${Date.now()}.db`;
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    for (const f of [path, `${path}-wal`, `${path}-shm`]) await rm(f, { force: true });
  });
  const a = new VaultStore(path, { maxVaults: 16, maxVaultBytes: 1024 });
  a.authorize(VAULT, TOKEN);
  a.put(VAULT, KEY, 0, Buffer.from("kept"));
  a.close();
  const b = new VaultStore(path, { maxVaults: 16, maxVaultBytes: 1024 });
  assert.equal(b.authorize(VAULT, "someone-else-0123456"), "forbidden");
  assert.equal(b.changes(VAULT, 0, 10).entries[0].data.toString(), "kept");
  b.close();
});

async function waitFor(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timed out");
}

async function withRelay(fn: (base: string) => Promise<void>, overrides: Partial<ReturnType<typeof loadConfig>> = {}) {
  const { httpServer, wss } = createRelay({ ...loadConfig(), host: "127.0.0.1", port: 0, vaultPath: ":memory:", ...overrides });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/vault/v1`;
  try {
    await fn(base);
  } finally {
    wss.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
}

const auth = (token = TOKEN) => ({ authorization: `Bearer ${token}` });

function putRecord(base: string, key: string, baseSeq: number, data: string, token = TOKEN) {
  return fetch(`${base}/${VAULT}/records/${key}`, {
    method: "PUT",
    headers: { ...auth(token), "content-type": "application/json" },
    body: JSON.stringify({ baseSeq, data: Buffer.from(data).toString("base64") }),
  });
}

test("HTTP: PUT then GET changes, 409 on a stale base", async () => {
  await withRelay(async (base) => {
    const put = await putRecord(base, KEY, 0, "hello");
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), { seq: 1 });

    const res = await fetch(`${base}/${VAULT}/changes?since=0`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.head, 1);
    assert.equal(body.more, false);
    assert.deepEqual(body.entries, [{ key: KEY, seq: 1, data: Buffer.from("hello").toString("base64") }]);

    const stale = await putRecord(base, KEY, 0, "again");
    assert.equal(stale.status, 409);
    assert.deepEqual((await stale.json()).entry, { key: KEY, seq: 1, data: Buffer.from("hello").toString("base64") });
  });
});

test("HTTP: auth is 401 without a bearer, 403 for a different one, 503 past the vault cap", async () => {
  await withRelay(async (base) => {
    assert.equal((await fetch(`${base}/${VAULT}/changes`)).status, 401);
    assert.equal((await fetch(`${base}/${VAULT}/changes`, { headers: auth("short") })).status, 401);
    assert.equal((await fetch(`${base}/${VAULT}/changes`, { headers: auth() })).status, 200);
    assert.equal((await fetch(`${base}/${VAULT}/changes`, { headers: auth("someone-else-0123456") })).status, 403);
    assert.equal((await putRecord(base, KEY, 0, "x", "someone-else-0123456")).status, 403);
    const full = await fetch(`${base}/${OTHER}/changes`, { headers: auth() });
    assert.equal(full.status, 503);
    assert.deepEqual(await full.json(), { error: "vault limit" });
  }, { maxVaults: 1 });
});

test("HTTP: bad ids, bodies and oversized blobs are refused", async () => {
  await withRelay(async (base) => {
    assert.equal((await fetch(`${base}/NOT-A-VAULT/changes`, { headers: auth() })).status, 400);
    assert.equal((await fetch(`${base}/${VAULT}/records/short`, { method: "PUT", headers: auth(), body: "{}" })).status, 400);
    assert.equal((await fetch(`${base}/${VAULT}/records/${KEY}`, { method: "PUT", headers: auth(), body: "nope" })).status, 400);
    assert.equal((await fetch(`${base}/${VAULT}/records/${KEY}`, { method: "PUT", headers: auth(), body: JSON.stringify({ baseSeq: -1, data: "" }) })).status, 400);
    assert.equal((await fetch(`${base}/${VAULT}/records/${KEY}`, { method: "PUT", headers: auth(), body: JSON.stringify({ baseSeq: 0, data: "a" }) })).status, 400);
    assert.equal((await fetch(`${base}/${VAULT}/changes`, { method: "PUT", headers: auth() })).status, 405);
    assert.equal((await fetch(`${base}/${VAULT}/elsewhere`, { headers: auth() })).status, 404);
    // decoded size over the cap, raw body still under the read cap
    assert.equal((await putRecord(base, KEY, 0, "x".repeat(17))).status, 413);
    // raw body over the read cap
    assert.equal((await putRecord(base, KEY, 0, "x".repeat(4096))).status, 413);
  }, { maxBlobBytes: 16 });
});

test("HTTP: a put past the vault quota is 507", async () => {
  await withRelay(async (base) => {
    assert.equal((await putRecord(base, KEY, 0, "12345678")).status, 200);
    assert.equal((await putRecord(base, KEY2, 0, "123")).status, 507);
  }, { maxVaultBytes: 10 });
});

test("HTTP: a long-poll wakes on a put and times out empty", async () => {
  await withRelay(async (base) => {
    const started = Date.now();
    const polling = fetch(`${base}/${VAULT}/changes?since=0&wait=20`, { headers: auth() }).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await putRecord(base, KEY, 0, "wake")).status, 200);
    const woke = await polling;
    assert.ok(Date.now() - started < 5_000, "answered on the put, not the timeout");
    assert.deepEqual(woke.entries.map((e: { seq: number }) => e.seq), [1]);

    const idle = Date.now();
    const empty = await (await fetch(`${base}/${VAULT}/changes?since=1&wait=1`, { headers: auth() })).json();
    assert.ok(Date.now() - idle >= 900, "held for the wait");
    assert.deepEqual(empty, { head: 1, entries: [], more: false });
  });
});

test("HTTP: a client that gives up on a long-poll is unparked", async () => {
  const s = store();
  const waiters: VaultWaiters = new Map();
  const server = createServer((req, res) => void handleVault(req, res, s, waiters, { maxBlobBytes: 1024 }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/vault/v1`;
  const ac = new AbortController();
  const polling = fetch(`${base}/${VAULT}/changes?wait=20`, { headers: auth(), signal: ac.signal }).catch(() => null);
  await waitFor(() => waiters.get(VAULT)?.size === 1);
  ac.abort();
  await polling;
  await waitFor(() => waiters.size === 0);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  s.close();
});
