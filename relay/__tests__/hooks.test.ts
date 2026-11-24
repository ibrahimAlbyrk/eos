import { test } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createPrivateKey, diffieHellman, hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../config.ts";
import { HookStore, KEEP_MS, MAX_EVENTS, MAX_HOOKS, MAX_INBOX_BYTES } from "../hooks/HookStore.ts";
import { HOOK_POSTS_PER_MINUTE } from "../hooks/rate.ts";
import { keptHeaders } from "../hooks/routes.ts";
import { publicKeyFromRaw, seal, SEAL_INFO } from "../hooks/seal.ts";
import { createRelay } from "../server.ts";

const VECTORS = JSON.parse(readFileSync(new URL("../../fixtures/relay/hook-seal.json", import.meta.url), "utf8"));
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SECRET = Buffer.from(VECTORS.recipientSecret, "hex");
const PUBLIC = Buffer.from(VECTORS.recipientPublic, "hex");
const INBOX = "1".repeat(32);
const OTHER_INBOX = "2".repeat(32);
const HOOK = "a".repeat(32);
const HOOK2 = "b".repeat(32);
const BEARER = "bearer-0123456789abcdef";

// The Mac's side of the format, as `eos-relay` opens it.
function open(sealed: Buffer, secret: Buffer = SECRET): Buffer {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, secret]), format: "der", type: "pkcs8" });
  const shared = diffieHellman({ privateKey, publicKey: publicKeyFromRaw(sealed.subarray(0, 32)) });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), SEAL_INFO, 32));
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(32, 44));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([decipher.update(sealed.subarray(44, sealed.length - 16)), decipher.final()]);
}

test("seal writes the shared vectors byte for byte and they open to the plaintext", () => {
  assert.equal(VECTORS.info, SEAL_INFO);
  assert.ok(VECTORS.cases.length >= 2);
  for (const c of VECTORS.cases) {
    const plaintext = Buffer.from(c.plaintext, "utf8");
    const sealed = seal(PUBLIC, plaintext, { ephemeralSecret: Buffer.from(c.ephemeralSecret, "hex"), nonce: Buffer.from(c.nonce, "hex") });
    assert.equal(sealed.toString("base64"), c.sealed);
    assert.deepEqual(open(Buffer.from(c.sealed, "base64")), plaintext);
  }
});

test("a fresh seal uses a new ephemeral key and nonce each time and fails under a tampered byte", () => {
  const a = seal(PUBLIC, Buffer.from("same"));
  const b = seal(PUBLIC, Buffer.from("same"));
  assert.equal(a.length, 32 + 12 + 4 + 16);
  assert.notDeepEqual(a.subarray(0, 44), b.subarray(0, 44));
  assert.equal(open(a).toString(), "same");
  const bad = Buffer.from(a);
  bad[50] ^= 1;
  assert.throws(() => open(bad));
});

function store(now = () => 1_000, maxInboxes = 16): HookStore {
  return new HookStore(":memory:", maxInboxes, now);
}

test("an inbox pins its first bearer, refuses others and new inboxes past the cap", () => {
  const s = store(() => 1_000, 1);
  assert.equal(s.ensure(INBOX, BEARER, PUBLIC), "ok");
  assert.equal(s.ensure(INBOX, BEARER, PUBLIC), "ok");
  assert.equal(s.ensure(INBOX, "someone-else-0123456", PUBLIC), "forbidden");
  assert.equal(s.authorize(INBOX, "someone-else-0123456"), "forbidden");
  assert.equal(s.authorize(OTHER_INBOX, BEARER), "unknown");
  assert.equal(s.ensure(OTHER_INBOX, BEARER, PUBLIC), "full");
  s.close();
});

test("an inbox holds at most 64 hooks, and a hook id belongs to one inbox", () => {
  const s = store();
  s.ensure(INBOX, BEARER, PUBLIC);
  s.ensure(OTHER_INBOX, BEARER, PUBLIC);
  for (let i = 0; i < MAX_HOOKS; i++) assert.equal(s.addHook(INBOX, i.toString(16).padStart(32, "0")), "ok");
  assert.equal(s.addHook(INBOX, HOOK), "full");
  assert.equal(s.addHook(INBOX, "0".repeat(32)), "ok");
  assert.equal(s.addHook(OTHER_INBOX, "0".repeat(32)), "taken");
  assert.equal(s.recipient(OTHER_INBOX, "0".repeat(32)), null);
  s.removeHook(INBOX, "0".repeat(32));
  assert.equal(s.recipient(INBOX, "0".repeat(32)), null);
  assert.equal(s.addHook(INBOX, HOOK), "ok");
  assert.deepEqual(s.recipient(INBOX, HOOK), PUBLIC);
  s.close();
});

test("seqs keep growing after an ack empties the inbox", () => {
  const s = store();
  s.ensure(INBOX, BEARER, PUBLIC);
  assert.equal(s.append(INBOX, Buffer.from("one")), 1);
  assert.equal(s.append(INBOX, Buffer.from("two")), 2);
  s.ack(INBOX, 2);
  assert.deepEqual(s.events(INBOX, 0, 100), { head: 2, entries: [], dropped: 0 });
  assert.equal(s.append(INBOX, Buffer.from("three")), 3);
  assert.deepEqual(s.events(INBOX, 2, 100).entries.map((e) => [e.seq, e.sealed.toString()]), [[3, "three"]]);
  s.close();
});

test("an inbox at 2,000 events or 64 MiB refuses the next one", () => {
  const s = store();
  s.ensure(INBOX, BEARER, PUBLIC);
  for (let i = 0; i < MAX_EVENTS; i++) s.append(INBOX, Buffer.from("x"));
  assert.equal(s.append(INBOX, Buffer.from("x")), "full");
  s.ack(INBOX, MAX_EVENTS);
  assert.equal(s.append(INBOX, Buffer.alloc(MAX_INBOX_BYTES - 10)), MAX_EVENTS + 1);
  assert.equal(s.append(INBOX, Buffer.alloc(11)), "full");
  assert.equal(s.append(INBOX, Buffer.alloc(10)), MAX_EVENTS + 2);
  s.close();
});

test("a page stops at 16 MiB of sealed bytes, never before its first entry", () => {
  const s = store();
  s.ensure(INBOX, BEARER, PUBLIC);
  for (let i = 0; i < 4; i++) s.append(INBOX, Buffer.alloc(6 * 1024 * 1024));
  assert.deepEqual(s.events(INBOX, 0, 100).entries.map((e) => e.seq), [1, 2]);
  assert.deepEqual(s.events(INBOX, 3, 100).entries.map((e) => e.seq), [4]);
  s.close();
});

test("the sweep drops events older than seven days and counts them per inbox", () => {
  let now = 1_000_000;
  const s = store(() => now);
  s.ensure(INBOX, BEARER, PUBLIC);
  s.ensure(OTHER_INBOX, BEARER, PUBLIC);
  s.append(INBOX, Buffer.from("old"));
  s.append(INBOX, Buffer.from("old too"));
  now += KEEP_MS / 2;
  s.append(INBOX, Buffer.from("young"));
  now += KEEP_MS / 2 + 1;
  const page = s.events(INBOX, 0, 100);
  assert.deepEqual(page.entries.map((e) => e.seq), [3]);
  assert.equal(page.dropped, 2);
  assert.equal(page.head, 3);
  assert.equal(s.events(OTHER_INBOX, 0, 100).dropped, 0);
  s.close();
});

test("only the headers a signature check needs are kept, within 8 KiB", () => {
  const kept = keptHeaders({
    "content-type": "application/json",
    cookie: "session=1",
    authorization: "Bearer x",
    "proxy-authorization": "Basic y",
    "x-forwarded-for": "1.2.3.4",
    "x-real-ip": "1.2.3.4",
    via: "1.1 caddy",
    "x-hub-signature-256": "sha256=ab",
    "x-big": "z".repeat(9000),
    "x-after": "dropped once the budget is spent",
  });
  assert.deepEqual(kept, { "content-type": "application/json", "x-hub-signature-256": "sha256=ab" });
});

async function withRelay(fn: (base: string, setNow: (ms: number) => void) => Promise<void>, overrides: Partial<ReturnType<typeof loadConfig>> = {}) {
  let now = 1_764_000_000_000;
  const { httpServer, wss } = createRelay({ ...loadConfig(), host: "127.0.0.1", port: 0, vaultPath: ":memory:", ...overrides }, () => now);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/hooks/v1`;
  try {
    await fn(base, (ms) => (now = ms));
  } finally {
    wss.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
}

const auth = (bearer = BEARER) => ({ authorization: `Bearer ${bearer}` });

async function setUp(base: string): Promise<void> {
  const put = await fetch(`${base}/${INBOX}`, { method: "PUT", headers: auth(), body: JSON.stringify({ publicKey: PUBLIC.toString("base64") }) });
  assert.equal(put.status, 200);
  assert.equal((await fetch(`${base}/${INBOX}/hooks/${HOOK}`, { method: "PUT", headers: auth() })).status, 200);
}

test("HTTP: an event posted to a hook reaches the Mac sealed, with its headers and body", async () => {
  await withRelay(async (base) => {
    await setUp(base);
    const posted = await fetch(`${base}/${INBOX}/${HOOK}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-delivery": "d-1", cookie: "a=b", "x-forwarded-for": "1.2.3.4" },
      body: '{"action":"opened"}',
    });
    assert.equal(posted.status, 202);
    const page = await (await fetch(`${base}/${INBOX}/events?since=0`, { headers: auth() })).json();
    assert.equal(page.head, 1);
    assert.equal(page.dropped, 0);
    assert.equal(page.entries.length, 1);
    const event = JSON.parse(open(Buffer.from(page.entries[0].sealed, "base64")).toString("utf8"));
    assert.equal(event.hook, HOOK);
    assert.equal(event.receivedAt, 1_764_000_000_000);
    assert.equal(event.headers["x-github-delivery"], "d-1");
    assert.equal(event.headers["content-type"], "application/json");
    assert.equal(event.headers.cookie, undefined);
    assert.equal(event.headers["x-forwarded-for"], undefined);
    assert.equal(Buffer.from(event.body, "base64").toString(), '{"action":"opened"}');
    assert.deepEqual(Object.keys(event), ["hook", "receivedAt", "headers", "body"]);

    assert.equal((await fetch(`${base}/${INBOX}/ack`, { method: "POST", headers: auth(), body: JSON.stringify({ through: 1 }) })).status, 200);
    assert.deepEqual(await (await fetch(`${base}/${INBOX}/events?since=0`, { headers: auth() })).json(), { head: 1, entries: [], dropped: 0 });
  });
});

test("HTTP: unknown hooks are 404, big bodies 413, a busy hook 429, a full inbox 507", async () => {
  await withRelay(async (base) => {
    await setUp(base);
    assert.equal((await fetch(`${base}/${INBOX}/${HOOK2}`, { method: "POST", body: "{}" })).status, 404);
    assert.equal((await fetch(`${base}/${OTHER_INBOX}/${HOOK}`, { method: "POST", body: "{}" })).status, 404);
    assert.equal((await fetch(`${base}/${INBOX}/${HOOK}`, { method: "POST", body: "x".repeat(1024 * 1024 + 1) })).status, 413);
    assert.equal((await fetch(`${base}/${INBOX}/${HOOK}`, { method: "GET" })).status, 405);
    for (let i = 1; i < HOOK_POSTS_PER_MINUTE; i++) {
      assert.equal((await fetch(`${base}/${INBOX}/${HOOK}`, { method: "POST", body: "{}" })).status, 202);
    }
    assert.equal((await fetch(`${base}/${INBOX}/${HOOK}`, { method: "POST", body: "{}" })).status, 429);
  });
  await withRelay(async (base, setNow) => {
    await setUp(base);
    const big = "y".repeat(1024 * 1024);
    let status = 202;
    let minute = 0;
    for (let i = 0; status === 202 && i < 200; i++) {
      if (i % 100 === 0) setNow(1_764_000_000_000 + ++minute * 61_000);
      status = (await fetch(`${base}/${INBOX}/${HOOK}`, { method: "POST", body: big })).status;
    }
    assert.equal(status, 507);
  });
});

test("HTTP: the Mac's calls need the inbox's own bearer", async () => {
  await withRelay(async (base) => {
    assert.equal((await fetch(`${base}/${INBOX}/events`)).status, 401);
    assert.equal((await fetch(`${base}/${INBOX}/events`, { headers: auth() })).status, 404);
    assert.equal((await fetch(`${base}/${INBOX}`, { method: "PUT", headers: auth(), body: JSON.stringify({ publicKey: "short" }) })).status, 400);
    await setUp(base);
    const other = auth("someone-else-0123456");
    assert.equal((await fetch(`${base}/${INBOX}/events`, { headers: other })).status, 403);
    assert.equal((await fetch(`${base}/${INBOX}/hooks/${HOOK2}`, { method: "PUT", headers: other })).status, 403);
    assert.equal((await fetch(`${base}/${INBOX}`, { method: "PUT", headers: other, body: JSON.stringify({ publicKey: PUBLIC.toString("base64") }) })).status, 403);
    assert.equal((await fetch(`${base}/${INBOX}/ack`, { method: "POST", headers: auth(), body: "{}" })).status, 400);
    assert.equal((await fetch(`${base}/NOT-HEX/events`, { headers: auth() })).status, 404);
    const full = await fetch(`${base}/${OTHER_INBOX}`, { method: "PUT", headers: auth(), body: JSON.stringify({ publicKey: PUBLIC.toString("base64") }) });
    assert.equal(full.status, 503);
    assert.equal((await fetch(`${base}/${INBOX}/hooks/${HOOK}`, { method: "DELETE", headers: auth() })).status, 200);
    assert.equal((await fetch(`${base}/${INBOX}/${HOOK}`, { method: "POST", body: "{}" })).status, 404);
  }, { maxHookInboxes: 1 });
});

test("HTTP: a long-poll wakes on an event", async () => {
  await withRelay(async (base) => {
    await setUp(base);
    const started = Date.now();
    const polling = fetch(`${base}/${INBOX}/events?since=0&wait=20`, { headers: auth() }).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await fetch(`${base}/${INBOX}/${HOOK}`, { method: "POST", body: "{}" })).status, 202);
    const woke = await polling;
    assert.ok(Date.now() - started < 5_000, "answered on the event, not the timeout");
    assert.deepEqual(woke.entries.map((e: { seq: number }) => e.seq), [1]);
  });
});
