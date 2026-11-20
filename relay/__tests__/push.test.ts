import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http2, { type IncomingHttpHeaders } from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { ApnsSender } from "../push/apns.ts";

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
