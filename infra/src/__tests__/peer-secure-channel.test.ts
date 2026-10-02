import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { Duplex, duplexPair } from "node:stream";
import type http2 from "node:http2";

import { createSelfSignedIdentity, certFingerprint, pemToDer } from "../peer/x509.ts";
import {
  connectSecure, openPeerSession, createSecurePeerServer, PeerIdentityError, PEER_WINDOW_BYTES,
  type PeerSessionInfo, type SecurePeerServer,
} from "../peer/secure-channel.ts";

const BIG_BYTES = 1024 * 1024;

// A byte pipe with a fixed one-way delay — a relay leg in miniature.
function laggyPair(oneWayMs: number): [Duplex, Duplex] {
  const ends: Duplex[] = [];
  const end = (i: number): Duplex => new Duplex({
    read() {},
    write(chunk, _enc, cb) { setTimeout(() => ends[1 - i].push(chunk), oneWayMs); cb(); },
    final(cb) { setTimeout(() => ends[1 - i].push(null), oneWayMs); cb(); },
  });
  ends.push(end(0), end(1));
  return [ends[0], ends[1]];
}
import { admitPeer } from "../../../core/src/domain/peer.ts";

function request(session: http2.ClientHttp2Session, path: string): Promise<{ status: number; body: string; chunks: number }> {
  return new Promise((resolve, reject) => {
    const req = session.request({ ":method": "GET", ":path": path });
    let status = 0;
    let body = "";
    let chunks = 0;
    req.on("response", (h) => { status = Number(h[":status"]); });
    req.setEncoding("utf8");
    req.on("data", (d: string) => { body += d; chunks++; });
    // A stream the peer cut before answering ends with no :status — that's a failure.
    req.on("end", () => (status ? resolve({ status, body, chunks }) : reject(new Error("no response"))));
    req.on("error", reject);
    req.end();
  });
}

function echoServer(serverId: ReturnType<typeof createSelfSignedIdentity>, trusted: Set<string>, seen: PeerSessionInfo[] = []): SecurePeerServer {
  return createSecurePeerServer({
    creds: serverId,
    admit: (fp) => {
      const admission = admitPeer({ fingerprint: fp, trusted, pairingOpen: false });
      return admission === "refused" ? { admission, reason: "not-paired" } : { admission };
    },
    onStream: (stream, headers, peer) => {
      seen.push(peer);
      if (headers[":path"] === "/stream") {
        // SSE-shaped: several writes on one long response, like /stream does.
        stream.respond({ ":status": 200, "content-type": "text/event-stream" });
        let n = 0;
        const t = setInterval(() => {
          stream.write(`data: ${n}\n\n`);
          if (++n === 3) { clearInterval(t); stream.end(); }
        }, 10);
        return;
      }
      if (headers[":path"] === "/big") {
        stream.respond({ ":status": 200, "content-type": "application/octet-stream" });
        stream.end(Buffer.alloc(BIG_BYTES, 120));
        return;
      }
      stream.respond({ ":status": 200, "content-type": "text/plain" });
      stream.end(`hello ${headers[":path"]}`);
    },
  });
}

describe("peer x509 identity", () => {
  test("builds a certificate TLS and X509Certificate accept", () => {
    const id = createSelfSignedIdentity({ commonName: "eos-test" });
    const cert = new X509Certificate(id.certPem);
    assert.ok(cert.verify(cert.publicKey), "self-signature verifies");
    assert.ok(cert.checkPrivateKey(createPrivateKey(id.keyPem)), "key matches cert");
    assert.equal(cert.subject, "CN=eos-test");
    assert.equal(certFingerprint(pemToDer(id.certPem)), id.fingerprint);
    assert.equal(cert.fingerprint256.replace(/:/g, "").toLowerCase(), id.fingerprint);
    assert.match(cert.validTo, /9999/);
  });

  test("every identity is distinct", () => {
    assert.notEqual(createSelfSignedIdentity().fingerprint, createSelfSignedIdentity().fingerprint);
  });
});

describe("peer secure channel", () => {
  const serverId = createSelfSignedIdentity();
  const clientId = createSelfSignedIdentity();

  test("TCP: pinned client reaches a trusting server over HTTP/2", async () => {
    const seen: PeerSessionInfo[] = [];
    const server = echoServer(serverId, new Set([clientId.fingerprint]), seen);
    const addr = await server.listen(0, "127.0.0.1");
    try {
      const sock = await connectSecure({ creds: clientId, expectFingerprint: serverId.fingerprint, transport: { host: "127.0.0.1", port: addr.port } });
      const session = openPeerSession(sock);
      const r = await request(session, "/workers");
      assert.deepEqual([r.status, r.body], [200, "hello /workers"]);
      assert.equal(seen[0].fingerprint, clientId.fingerprint);
      assert.equal(seen[0].admission, "trusted");
      assert.deepEqual(server.connected(), [clientId.fingerprint]);
      session.close();
    } finally {
      await server.close();
    }
  });

  test("client refuses a server whose fingerprint is not the pinned one", async () => {
    const impostor = createSelfSignedIdentity();
    const server = echoServer(impostor, new Set([clientId.fingerprint]));
    const addr = await server.listen(0, "127.0.0.1");
    try {
      await assert.rejects(
        connectSecure({ creds: clientId, expectFingerprint: serverId.fingerprint, transport: { host: "127.0.0.1", port: addr.port } }),
        (e: unknown) => e instanceof PeerIdentityError && e.actual === impostor.fingerprint,
      );
    } finally {
      await server.close();
    }
  });

  test("server drops an unknown client before any request is handled", async () => {
    const seen: PeerSessionInfo[] = [];
    const server = echoServer(serverId, new Set(), seen);
    const addr = await server.listen(0, "127.0.0.1");
    try {
      const sock = await connectSecure({ creds: clientId, expectFingerprint: serverId.fingerprint, transport: { host: "127.0.0.1", port: addr.port } });
      const session = openPeerSession(sock);
      session.on("error", () => {});
      const goaway = new Promise<string>((resolve) => session.once("goaway", (_code: number, _last: number, data?: Buffer) => resolve(data?.toString("utf8") ?? "")));
      await assert.rejects(request(session, "/workers"));
      assert.equal(await goaway, "not-paired", "refused peer is told why");
      assert.equal(seen.length, 0);
    } finally {
      await server.close();
    }
  });

  test("Duplex transport (relay leg): same TLS + HTTP/2, streaming responses arrive incrementally", async () => {
    const server = echoServer(serverId, new Set([clientId.fingerprint]));
    try {
      const [clientEnd, serverEnd] = duplexPair();
      server.accept(serverEnd);
      const sock = await connectSecure({ creds: clientId, expectFingerprint: serverId.fingerprint, transport: clientEnd });
      const session = openPeerSession(sock);
      const r = await request(session, "/stream");
      assert.equal(r.status, 200);
      assert.equal(r.body, "data: 0\n\ndata: 1\n\ndata: 2\n\n");
      assert.ok(r.chunks >= 2, `expected incremental chunks, got ${r.chunks}`);
      const many = await Promise.all(Array.from({ length: 25 }, (_, i) => request(session, `/r/${i}`)));
      assert.deepEqual(many.map((m) => m.body), Array.from({ length: 25 }, (_, i) => `hello /r/${i}`));
      session.close();
    } finally {
      await server.close();
    }
  });

  test("a high-latency link moves a large response in a round trip or two, not one per 64 KB", async () => {
    const server = echoServer(serverId, new Set([clientId.fingerprint]));
    try {
      const [clientEnd, serverEnd] = laggyPair(50);
      server.accept(serverEnd);
      const sock = await connectSecure({ creds: clientId, expectFingerprint: serverId.fingerprint, transport: clientEnd });
      const session = openPeerSession(sock);
      await request(session, "/warm");
      assert.equal(session.remoteSettings.initialWindowSize, PEER_WINDOW_BYTES, "the host opened its stream window");
      const t0 = performance.now();
      const r = await request(session, "/big");
      const ms = performance.now() - t0;
      assert.equal(r.body.length, BIG_BYTES);
      // 1 MB through HTTP/2's default 64 KB window takes 16 round trips (≥1.6 s here).
      assert.ok(ms < 800, `1 MB over a 100 ms RTT link took ${Math.round(ms)} ms`);
      session.close();
    } finally {
      await server.close();
    }
  });

  test("disconnect(fingerprint) tears down that device's live sessions", async () => {
    const server = echoServer(serverId, new Set([clientId.fingerprint]));
    const addr = await server.listen(0, "127.0.0.1");
    try {
      const sock = await connectSecure({ creds: clientId, expectFingerprint: serverId.fingerprint, transport: { host: "127.0.0.1", port: addr.port } });
      const session = openPeerSession(sock);
      await request(session, "/ping");
      const closed = new Promise<void>((resolve) => session.once("close", () => resolve()));
      session.on("error", () => {});
      assert.equal(server.disconnect(clientId.fingerprint), 1);
      await closed;
      assert.deepEqual(server.connected(), []);
    } finally {
      await server.close();
    }
  });
});
