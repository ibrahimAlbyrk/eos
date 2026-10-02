// The Eos ↔ Eos secure channel: HTTP/2 over TLS 1.3 with both ends pinned.
//
// One stack for every path. TCP (LAN/Tailnet) and the relay (a Duplex that
// carries opaque bytes) both feed the SAME tls.Server / tls.connect, so the
// relay only ever sees ciphertext and a path switch changes nothing above the
// socket. Chains are never validated: each side checks the other's certificate
// fingerprint against what it pinned at pairing time (Syncthing's model).

import http2 from "node:http2";
import tls from "node:tls";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { certFingerprint } from "./x509.ts";
import type { PeerAdmission } from "../../../core/src/domain/peer.ts";

export interface PeerCredentials {
  keyPem: string;
  certPem: string;
}

const TLS_BASE = { minVersion: "TLSv1.3", ALPNProtocols: ["h2"] } as const;
const HANDSHAKE_TIMEOUT_MS = 10_000;
// HTTP/2 starts every stream AND the whole connection at a 64 KB flow-control
// window: a link then moves at most 64 KB per round trip (~400 KB/s over a
// 150 ms relay), and one large response holds every event stream behind it.
// Open both wide so a link runs at its bandwidth, not its latency.
export const PEER_WINDOW_BYTES = 16 * 1024 * 1024;
const H2_SETTINGS = { initialWindowSize: PEER_WINDOW_BYTES } as const;

export class PeerIdentityError extends Error {
  readonly expected: string;
  readonly actual: string | null;
  constructor(expected: string, actual: string | null) {
    super(`peer identity mismatch: expected ${expected.slice(0, 16)}…, got ${actual ? actual.slice(0, 16) + "…" : "no certificate"}`);
    this.name = "PeerIdentityError";
    this.expected = expected;
    this.actual = actual;
  }
}

export function peerFingerprint(sock: tls.TLSSocket): string | null {
  const cert = sock.getPeerX509Certificate();
  return cert ? certFingerprint(cert.raw) : null;
}

export type PeerTransport = { host: string; port: number } | Duplex;

// Resolve only after the server proved the pinned identity; nothing is sent to
// an unverified peer because the HTTP/2 session is opened on the returned socket.
export function connectSecure(args: {
  creds: PeerCredentials;
  expectFingerprint: string;
  transport: PeerTransport;
  timeoutMs?: number;
}): Promise<tls.TLSSocket> {
  const opts: tls.ConnectionOptions = { ...TLS_BASE, key: args.creds.keyPem, cert: args.creds.certPem, rejectUnauthorized: false };
  const t = args.transport;
  const sock = "host" in t && typeof t.host === "string"
    ? tls.connect({ ...opts, host: t.host, port: (t as { port: number }).port })
    : tls.connect({ ...opts, socket: t as Duplex });
  return new Promise((resolve, reject) => {
    const fail = (e: Error): void => { clearTimeout(timer); sock.destroy(); reject(e); };
    const timer = setTimeout(() => fail(new Error("tls handshake timed out")), args.timeoutMs ?? HANDSHAKE_TIMEOUT_MS);
    sock.once("error", fail);
    sock.once("secureConnect", () => {
      clearTimeout(timer);
      const fp = peerFingerprint(sock);
      if (fp !== args.expectFingerprint) { fail(new PeerIdentityError(args.expectFingerprint, fp)); return; }
      if (sock.alpnProtocol !== "h2") { fail(new Error("peer did not negotiate h2")); return; }
      sock.removeListener("error", fail);
      // The HTTP/2 session installs its own handling; until then a late error
      // must not become an uncaught exception.
      sock.on("error", () => {});
      // Keystrokes and small frames go out at once instead of waiting on Nagle.
      sock.setNoDelay(true);
      resolve(sock);
    });
  });
}

export function openPeerSession(sock: tls.TLSSocket): http2.ClientHttp2Session {
  const session = http2.connect("https://eos-peer", { createConnection: () => sock, settings: H2_SETTINGS });
  session.once("connect", () => { if (!session.destroyed) session.setLocalWindowSize(PEER_WINDOW_BYTES); });
  return session;
}

export interface PeerSessionInfo {
  fingerprint: string;
  admission: Exclude<PeerAdmission, "refused">;
}

export interface AdmissionDecision {
  admission: PeerAdmission;
  // Sent to a refused peer as GOAWAY opaque data so it can stop retrying.
  reason?: string;
}

type SessionTag = PeerSessionInfo | { fingerprint: string; admission: "refused"; reason: string };

const PEER = Symbol("eos.peer");
type TaggedSocket = tls.TLSSocket & { [PEER]?: SessionTag };
// A refused session lives only long enough to deliver its GOAWAY.
const REFUSED_LINGER_MS = 1000;

export interface SecurePeerServer {
  // No host ⇒ every interface, dual-stack.
  listen(port: number, host?: string): Promise<AddressInfo>;
  // Stop accepting direct connections; live sessions stay up.
  unlisten(): Promise<void>;
  readonly listening: boolean;
  // Feed an already-open byte pipe (the relay leg) through the same TLS server.
  accept(transport: Duplex): void;
  // Drop every live session of a device — revocation and "Disconnect".
  disconnect(fingerprint: string): number;
  disconnectAll(): void;
  connected(): string[];
  close(): Promise<void>;
}

export function createSecurePeerServer(args: {
  creds: PeerCredentials;
  admit: (fingerprint: string) => AdmissionDecision;
  onStream: (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders, peer: PeerSessionInfo) => void;
  onSession?: (peer: PeerSessionInfo, event: "open" | "close") => void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}): SecurePeerServer {
  const sessions = new Map<string, Set<http2.ServerHttp2Session>>();

  const h2 = http2.createServer({ settings: H2_SETTINGS });
  h2.on("session", (session) => {
    const tag = (session.socket as unknown as TaggedSocket)[PEER];
    if (!tag) { session.destroy(); return; }
    session.on("error", () => {});
    if (tag.admission === "refused") {
      session.on("stream", (stream) => { stream.on("error", () => {}); stream.close(http2.constants.NGHTTP2_REFUSED_STREAM); });
      session.goaway(http2.constants.NGHTTP2_REFUSED_STREAM, 0, Buffer.from(tag.reason, "utf8"));
      setTimeout(() => session.destroy(), REFUSED_LINGER_MS).unref();
      return;
    }
    session.setLocalWindowSize(PEER_WINDOW_BYTES);
    const peer: PeerSessionInfo = tag;
    const set = sessions.get(peer.fingerprint) ?? new Set();
    set.add(session);
    sessions.set(peer.fingerprint, set);
    args.onSession?.(peer, "open");
    session.on("stream", (stream, headers) => {
      // A device resetting a stream (closed tab, dropped link) surfaces as a
      // stream 'error'; unhandled, that would take the whole daemon down.
      stream.on("error", () => {});
      args.onStream(stream, headers, peer);
    });
    session.once("close", () => {
      set.delete(session);
      if (set.size === 0) sessions.delete(peer.fingerprint);
      args.onSession?.(peer, "close");
    });
  });

  const tlsServer = tls.createServer({
    ...TLS_BASE,
    key: args.creds.keyPem,
    cert: args.creds.certPem,
    requestCert: true,
    rejectUnauthorized: false,
    handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
  });
  tlsServer.on("secureConnection", (sock: TaggedSocket) => {
    const fingerprint = peerFingerprint(sock);
    if (!fingerprint || sock.alpnProtocol !== "h2") { sock.destroy(); return; }
    sock.setNoDelay(true);
    const decision = args.admit(fingerprint);
    if (decision.admission === "refused") {
      args.log?.("peer refused", { fingerprint: fingerprint.slice(0, 16), reason: decision.reason ?? null });
      sock[PEER] = { fingerprint, admission: "refused", reason: decision.reason ?? "refused" };
    } else {
      sock[PEER] = { fingerprint, admission: decision.admission };
    }
    h2.emit("connection", sock);
  });
  tlsServer.on("tlsClientError", (e) => args.log?.("peer handshake failed", { error: e.message }));

  const disconnect = (fingerprint: string): number => {
    const set = sessions.get(fingerprint);
    if (!set) return 0;
    sessions.delete(fingerprint);
    for (const s of set) s.destroy();
    return set.size;
  };
  // Stops accepting at once. close()'s callback would wait for every live
  // session to end — those are managed (disconnect) separately.
  const unlisten = (): Promise<void> => {
    if (tlsServer.listening) tlsServer.close();
    return Promise.resolve();
  };

  return {
    listen: (port, host) => new Promise((resolve, reject) => {
      tlsServer.once("error", reject);
      const done = (): void => {
        tlsServer.removeListener("error", reject);
        resolve(tlsServer.address() as AddressInfo);
      };
      if (host) tlsServer.listen(port, host, done);
      else tlsServer.listen(port, done);
    }),
    unlisten,
    get listening() { return tlsServer.listening; },
    accept: (transport) => { tlsServer.emit("connection", transport); },
    disconnect,
    disconnectAll: () => { for (const fp of [...sessions.keys()]) disconnect(fp); },
    connected: () => [...sessions.keys()],
    close: async () => {
      for (const fp of [...sessions.keys()]) disconnect(fp);
      await unlisten();
    },
  };
}
