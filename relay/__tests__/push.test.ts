import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http2, { type IncomingHttpHeaders } from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { WebSocket } from "ws";
import { sha256Hex } from "../admission.ts";
import { Dir, encodeJsonEnvelope, FrameType } from "../envelope.ts";
import { ApnsSender } from "../push/apns.ts";
import { PUSHES_PER_HOUR, PUSHES_PER_MINUTE, PushRate } from "../push/rate.ts";
import type { PushTokens } from "../push/tokens.ts";
import { createRelay } from "../server.ts";
import { Inbox, body } from "./ws-inbox.ts";

const ROOM = "room-0123456789";
const TOKEN = "ab".repeat(32);

type Seen = { headers: IncomingHttpHeaders; body: string };
// Answers per device token; a token not listed gets 200.
type Answers = Record<string, { status: number; body?: string }>;

async function withFakeApns(answers: Answers, fn: (origin: string, seen: Seen[]) => Promise<void>) {
  const seen: Seen[] = [];
  const server = http2.createServer();
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => (body += chunk));
    stream.on("end", () => {
      seen.push({ headers, body });
      const answer = answers[String(headers[":path"]).split("/").pop() ?? ""] ?? { status: 200 };
      stream.respond({ ":status": answer.status });
      stream.end(answer.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(origin, seen);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function withKey(fn: (keyPath: string, publicKey: KeyObject) => Promise<void>) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const dir = mkdtempSync(join(tmpdir(), "relay-apns-"));
  const keyPath = join(dir, "AuthKey.p8");
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
  return fn(keyPath, publicKey).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function sender(keyPath: string, origin: string, now: () => number) {
  const env = { APNS_KEY: keyPath, APNS_KEY_ID: "KEY1234567", APNS_TEAM_ID: "TEAM123456", APNS_BUNDLE_ID: "com.example.eos" };
  return new ApnsSender({ ...loadConfig(env), apnsOrigins: { production: origin, sandbox: origin } }, now);
}

function decode(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString());
}

test("the request carries a verifiable ES256 token and exactly the table's headers and payload", async () => {
  await withKey(async (keyPath, publicKey) => {
    await withFakeApns({}, async (origin, seen) => {
      const nowMs = 1_800_000_000_000;
      const apns = sender(keyPath, origin, () => nowMs);
      assert.deepEqual(await apns.send(ROOM, "needs_you", 3, [{ token: TOKEN, env: "production" }]), [{ result: "sent" }]);
      apns.close();

      assert.equal(seen.length, 1);
      const { headers, body } = seen[0];
      assert.equal(headers[":method"], "POST");
      assert.equal(headers[":path"], `/3/device/${TOKEN}`);
      assert.equal(headers["apns-push-type"], "alert");
      assert.equal(headers["apns-topic"], "com.example.eos");
      assert.equal(headers["apns-collapse-id"], "needs_you");
      assert.equal(headers["apns-expiration"], String(1_800_000_000 + 86_400));
      assert.equal(headers["apns-priority"], "10");

      const auth = String(headers.authorization);
      assert.ok(auth.startsWith("bearer "));
      const [header, claims, signature] = auth.slice(7).split(".");
      assert.deepEqual(decode(header), { alg: "ES256", kid: "KEY1234567" });
      assert.deepEqual(decode(claims), { iss: "TEAM123456", iat: 1_800_000_000 });
      const signed = Buffer.from(`${header}.${claims}`);
      assert.ok(verify("sha256", signed, { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")));

      const m = createHash("sha256").update(ROOM).digest("hex").slice(0, 8);
      assert.equal(
        body,
        `{"aps":{"alert":{"title-loc-key":"push.needs_you.title","loc-key":"push.needs_you.body","loc-args":["3"]},"badge":3,"sound":"default","thread-id":"needs_you"},"m":"${m}"}`,
      );
    });
  });
});

test("the provider token is reused for 50 minutes and made again after", async () => {
  await withKey(async (keyPath) => {
    await withFakeApns({}, async (origin, seen) => {
      let nowMs = 1_800_000_000_000;
      const apns = sender(keyPath, origin, () => nowMs);
      const target = [{ token: TOKEN, env: "sandbox" as const }];
      await apns.send(ROOM, "test", 1, target);
      nowMs += 49 * 60 * 1000;
      await apns.send(ROOM, "test", 1, target);
      nowMs += 60 * 1000;
      await apns.send(ROOM, "test", 1, target);
      apns.close();

      const [first, second, third] = seen.map((s) => String(s.headers.authorization));
      assert.equal(second, first);
      assert.notEqual(third, first);
      assert.deepEqual(decode(third.slice(7).split(".")[1]), { iss: "TEAM123456", iat: 1_800_000_000 + 50 * 60 });
    });
  });
});

test("each token gets its own result: 200 sent, 410 and dead tokens gone, anything else failed", async () => {
  const gone410 = "01".repeat(32);
  const bad = "02".repeat(32);
  const unregistered = "03".repeat(32);
  const broken = "04".repeat(32);
  const busy = "05".repeat(32);
  const other400 = "06".repeat(32);
  const answers: Answers = {
    [gone410]: { status: 410, body: '{"reason":"Unregistered"}' },
    [bad]: { status: 400, body: '{"reason":"BadDeviceToken"}' },
    [unregistered]: { status: 400, body: '{"reason":"Unregistered"}' },
    [broken]: { status: 500, body: '{"reason":"InternalServerError"}' },
    [busy]: { status: 429 },
    [other400]: { status: 400, body: '{"reason":"BadCollapseId"}' },
  };
  await withKey(async (keyPath) => {
    await withFakeApns(answers, async (origin, seen) => {
      const apns = sender(keyPath, origin, () => 1_800_000_000_000);
      const tokens = [TOKEN, gone410, bad, unregistered, broken, busy, other400];
      const results = await apns.send(ROOM, "run_failed", 1, tokens.map((token) => ({ token, env: "production" as const })));
      apns.close();
      assert.deepEqual(results, [
        { result: "sent" },
        { result: "gone" },
        { result: "gone" },
        { result: "gone" },
        { result: "failed", reason: "InternalServerError" },
        { result: "failed", reason: "status-429" },
        { result: "failed", reason: "BadCollapseId" },
      ]);
      assert.equal(seen.length, tokens.length, "nothing is retried");
    });
  });
});

test("unset config answers not-configured and sends nothing", async () => {
  await withFakeApns({}, async (origin, seen) => {
    const env = { APNS_KEY_ID: "KEY1234567", APNS_TEAM_ID: "TEAM123456", APNS_BUNDLE_ID: "com.example.eos" };
    const config = loadConfig(env);
    assert.equal(config.apns, null);
    assert.deepEqual(config.apnsOrigins, { production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" });
    const apns = new ApnsSender({ ...config, apnsOrigins: { production: origin, sandbox: origin } });
    assert.equal(await apns.send(ROOM, "ready", 2, [{ token: TOKEN, env: "production" }]), "not-configured");
    assert.equal(seen.length, 0);
  });
});

test("an unknown kind or a count that is not a whole number is refused before sending", async () => {
  await withKey(async (keyPath) => {
    await withFakeApns({}, async (origin, seen) => {
      const apns = sender(keyPath, origin, () => 1_800_000_000_000);
      const target = [{ token: TOKEN, env: "production" as const }];
      await assert.rejects(apns.send(ROOM, "hello <b>world</b>", 1, target), RangeError);
      await assert.rejects(apns.send(ROOM, "routine_paused", 1.5, target), RangeError);
      await assert.rejects(apns.send(ROOM, "routine_paused", -1, target), RangeError);
      apns.close();
      assert.equal(seen.length, 0);
    });
  });
});

test("a connection dropped before Apple answers is failed as unreachable", async () => {
  await withKey(async (keyPath) => {
    const server = http2.createServer();
    server.on("stream", (stream) => stream.session?.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const apns = sender(keyPath, origin, () => 1_800_000_000_000);
      const results = await apns.send(ROOM, "test", 1, [{ token: TOKEN, env: "production" }]);
      apns.close();
      assert.deepEqual(results, [{ result: "failed", reason: "unreachable" }]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// ── Rooms: stored tokens, the owner's push, the HTTP route, the rate ──

const OWNER = "owner-secret";
const PHONE = "phone-bearer";
const OTHER_PHONE = "other-phone-bearer";
const OTHER_TOKEN = "cd".repeat(32);

type Relay = { url: string; http: string; tokens: PushTokens; db: string };

// A relay on a temp SQLite file, its APNs pointed at the fake (unconfigured with keyPath null).
async function withRelay(keyPath: string | null, origin: string, fn: (relay: Relay) => Promise<void>, db?: string) {
  const dir = mkdtempSync(join(tmpdir(), "relay-push-"));
  const vaultPath = db ?? join(dir, "relay.db");
  const env = keyPath ? { APNS_KEY: keyPath, APNS_KEY_ID: "KEY1234567", APNS_TEAM_ID: "TEAM123456", APNS_BUNDLE_ID: "com.example.eos" } : {};
  const config = { ...loadConfig(env), port: 0, vaultPath, apnsOrigins: { production: origin, sandbox: origin } };
  const { httpServer, wss, tokens } = createRelay(config);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as AddressInfo).port;
  try {
    await fn({ url: `ws://127.0.0.1:${port}`, http: `http://127.0.0.1:${port}`, tokens, db: vaultPath });
  } finally {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

async function connect(url: string) {
  const ws = new WebSocket(url);
  await once(ws, "open");
  return { ws, inbox: new Inbox(ws) };
}

function frame(type: FrameType, json: Record<string, unknown>): Buffer {
  return encodeJsonEnvelope({ type, room: ROOM, dir: Dir.c2s, json: { room: ROOM, ...json } });
}

async function register(url: string, allow = [sha256Hex(PHONE), sha256Hex(OTHER_PHONE)], owner = OWNER) {
  const mac = await connect(url);
  mac.ws.send(frame(FrameType.register, { t: "register", owner, allow }));
  return { ...mac, answer: body(await mac.inbox.next()) };
}

// Joins a phone and waits for the ack; the Mac's own "joined" notice is read off its inbox.
async function joinPhone(url: string, mac: Inbox, json: Record<string, unknown>) {
  const phone = await connect(url);
  phone.ws.send(frame(FrameType.join, { t: "join", ...json }));
  assert.equal(body(await phone.inbox.next()).t, "joined");
  assert.equal(body(await mac.next()).t, "joined");
  return phone;
}

async function pushOver(mac: { ws: WebSocket; inbox: Inbox }, json: Record<string, unknown> = { kind: "needs_you", count: 2 }) {
  mac.ws.send(frame(FrameType.relayctl, { t: "push", ...json }));
  return body(await mac.inbox.next());
}

function postPush(http: string, bearer: string, json: unknown, room = ROOM) {
  return fetch(`${http}/push/v1/${room}`, { method: "POST", headers: { authorization: `Bearer ${bearer}` }, body: JSON.stringify(json) });
}

test("a join stores the token with its env; a phone that names no env is production", async () => {
  await withRelay(null, "http://127.0.0.1:9", async ({ url, tokens }) => {
    const mac = await register(url);
    await joinPhone(url, mac.inbox, { bearer: PHONE, apnsToken: TOKEN, apnsEnv: "sandbox", later: "ignored" });
    await joinPhone(url, mac.inbox, { bearer: OTHER_PHONE, apnsToken: OTHER_TOKEN });
    assert.deepEqual(
      tokens.targets(ROOM).sort((a, b) => a.token.localeCompare(b.token)),
      [
        { deviceHash: sha256Hex(PHONE), token: TOKEN, env: "sandbox" },
        { deviceHash: sha256Hex(OTHER_PHONE), token: OTHER_TOKEN, env: "production" },
      ],
    );
  });
});

test("only the owner socket pushes; the payload reaching Apple is exactly the table", async () => {
  await withKey(async (keyPath) => {
    await withFakeApns({}, async (origin, seen) => {
      await withRelay(keyPath, origin, async ({ url }) => {
        const mac = await register(url);
        const phone = await joinPhone(url, mac.inbox, { bearer: PHONE, apnsToken: TOKEN });
        phone.ws.send(frame(FrameType.relayctl, { t: "push", kind: "needs_you", count: 2 }));
        assert.deepEqual(body(await phone.inbox.next()), { t: "error", code: "OWNER_MISMATCH", message: "only the room's owner may push" });
        assert.equal(seen.length, 0);

        assert.deepEqual(await pushOver(mac), { t: "push-result", sent: 1, failed: 0, gone: 0 });
        const m = createHash("sha256").update(ROOM).digest("hex").slice(0, 8);
        assert.equal(seen.length, 1);
        assert.equal(seen[0].headers[":path"], `/3/device/${TOKEN}`);
        assert.equal(
          seen[0].body,
          `{"aps":{"alert":{"title-loc-key":"push.needs_you.title","loc-key":"push.needs_you.body","loc-args":["2"]},"badge":2,"sound":"default","thread-id":"needs_you"},"m":"${m}"}`,
        );

        assert.equal((await pushOver(mac, { kind: "hello", count: 1 })).code, "BAD_REQUEST");
        assert.equal(seen.length, 1);
      });
    });
  });
});

test("unset APNs config answers not-configured", async () => {
  await withFakeApns({}, async (origin, seen) => {
    await withRelay(null, origin, async ({ url }) => {
      const mac = await register(url);
      await joinPhone(url, mac.inbox, { bearer: PHONE, apnsToken: TOKEN });
      assert.deepEqual(await pushOver(mac), { t: "push-result", sent: 0, failed: 1, gone: 0, reason: "not-configured" });
      assert.equal(seen.length, 0);
    });
  });
});

test("the HTTP route sends with the owner's bearer while the Mac is away, and after a restart", async () => {
  await withKey(async (keyPath) => {
    await withFakeApns({}, async (origin, seen) => {
      const dir = mkdtempSync(join(tmpdir(), "relay-restart-"));
      const db = join(dir, "relay.db");
      try {
        await withRelay(keyPath, origin, async ({ url, http }) => {
          const mac = await register(url);
          await joinPhone(url, mac.inbox, { bearer: PHONE, apnsToken: TOKEN });
          mac.ws.close();
          await once(mac.ws, "close");
          const ok = await postPush(http, OWNER, { kind: "run_failed", count: 1 });
          assert.equal(ok.status, 200);
          assert.deepEqual(await ok.json(), { sent: 1, failed: 0, gone: 0 });
        }, db);
        await withRelay(keyPath, origin, async ({ url, http }) => {
          const ok = await postPush(http, OWNER, { kind: "ready", count: 4 });
          assert.deepEqual(await ok.json(), { sent: 1, failed: 0, gone: 0 });
          assert.equal((await postPush(http, "someone-else", { kind: "ready", count: 4 })).status, 401);
          assert.equal((await fetch(`${http}/push/v1/${ROOM}`, { method: "POST", body: "{}" })).status, 401);
          assert.equal((await postPush(http, OWNER, { kind: "ready", count: 4 }, "BBBBBBBBBBBBBBBBBBBBBB")).status, 404);
          assert.equal((await postPush(http, OWNER, { kind: "ready" })).status, 400);
          assert.equal((await postPush(http, OWNER, "not an object")).status, 400);
          // The owner kept from the earlier run still holds the room against a newcomer.
          assert.equal((await register(url, [], "impostor")).answer.code, "OWNER_MISMATCH");
        }, db);
        assert.equal(seen.length, 2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

test("31 pushes in a minute: the 31st is throttled, over the socket and over HTTP", async () => {
  await withKey(async (keyPath) => {
    await withFakeApns({}, async (origin, seen) => {
      await withRelay(keyPath, origin, async ({ url, http }) => {
        const mac = await register(url);
        await joinPhone(url, mac.inbox, { bearer: PHONE, apnsToken: TOKEN });
        for (let i = 0; i < 30; i++) assert.equal((await pushOver(mac, { kind: "test", count: i })).sent, 1);
        assert.deepEqual(await pushOver(mac, { kind: "test", count: 30 }), { t: "push-result", sent: 0, failed: 0, gone: 0, reason: "throttled" });
        const throttled = await postPush(http, OWNER, { kind: "test", count: 30 });
        assert.equal(throttled.status, 429);
        assert.equal(seen.length, 30);
      });
    });
  });
});

test("the rate allows 30 a minute and 300 an hour per room", () => {
  let nowMs = 0;
  const rate = new PushRate(() => nowMs);
  for (let minute = 0; minute < 10; minute++) {
    nowMs = minute * 60_000;
    for (let i = 0; i < PUSHES_PER_MINUTE; i++) assert.ok(rate.take(ROOM));
    assert.equal(rate.take(ROOM), false);
  }
  nowMs = 59 * 60_000;
  assert.equal(rate.take(ROOM), false, "300 in the hour");
  assert.ok(rate.take("another-room"));
  nowMs = 60 * 60_000;
  assert.ok(rate.take(ROOM), "the first minute's pushes left the hour");
  assert.equal(PUSHES_PER_HOUR, 300);
});

test("a token Apple calls gone is deleted", async () => {
  await withKey(async (keyPath) => {
    await withFakeApns({ [OTHER_TOKEN]: { status: 410, body: '{"reason":"Unregistered"}' } }, async (origin) => {
      await withRelay(keyPath, origin, async ({ url, tokens }) => {
        const mac = await register(url);
        await joinPhone(url, mac.inbox, { bearer: PHONE, apnsToken: TOKEN });
        await joinPhone(url, mac.inbox, { bearer: OTHER_PHONE, apnsToken: OTHER_TOKEN });
        assert.deepEqual(await pushOver(mac), { t: "push-result", sent: 1, failed: 0, gone: 1 });
        assert.deepEqual(tokens.targets(ROOM).map((t) => t.token), [TOKEN]);
      });
    });
  });
});

test("removing a device deletes its token, by allow-remove or by a register that leaves it out", async () => {
  await withRelay(null, "http://127.0.0.1:9", async ({ url, tokens }) => {
    const mac = await register(url);
    await joinPhone(url, mac.inbox, { bearer: PHONE, apnsToken: TOKEN });
    await joinPhone(url, mac.inbox, { bearer: OTHER_PHONE, apnsToken: OTHER_TOKEN });
    mac.ws.send(frame(FrameType.relayctl, { t: "allow-remove", hash: sha256Hex(PHONE).toUpperCase() }));
    // The push after it is answered only once the removal was handled.
    await pushOver(mac);
    assert.deepEqual(tokens.targets(ROOM).map((t) => t.token), [OTHER_TOKEN]);

    assert.equal((await register(url, [])).answer.t, "registered");
    assert.deepEqual(tokens.targets(ROOM), []);
  });
});

test("the provisional pushIntent is gone: it reaches nobody", async () => {
  assert.equal(existsSync(new URL("../apns.ts", import.meta.url)), false);
  await withKey(async (keyPath) => {
    await withFakeApns({}, async (origin, seen) => {
      await withRelay(keyPath, origin, async ({ url }) => {
        const mac = await register(url);
        await joinPhone(url, mac.inbox, { bearer: PHONE, apnsToken: TOKEN });
        mac.ws.send(frame(FrameType.relayctl, { t: "pushIntent", title: "hello", body: "world" }));
        assert.equal((await pushOver(mac)).sent, 1);
        assert.equal(seen.length, 1, "only the push frame reached Apple");
      });
    });
  });
});
