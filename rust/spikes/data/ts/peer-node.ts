// The Node end of the peer spikes: today's TypeScript identity generator and
// secure channel (infra/src/peer/), driven by spike-peer's tests over stdout
// JSON lines. Identities are made on the spot with invented names.
//
//   gen <dir> <commonName>
//   certs <n>                                                (prints n fresh certificates, DER in base64; no keys)
//   server <dir> <trustedFingerprint|-> [refusalReason]     (prints {port}; ends when stdin closes)
//   client <dir> <port> <expectFingerprint> <path>
//   reverse-device <dir> <port> <expectFingerprint>          (offers POST /peer/reverse, serves through it)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type http2 from "node:http2";
import { join } from "node:path";

import {
  connectSecure, createSecurePeerServer, openPeerSession, PeerIdentityError,
  type PeerCredentials, type PeerSessionInfo,
} from "../../../../infra/src/peer/secure-channel.ts";
import { certFingerprint, createSelfSignedIdentity, pemToDer } from "../../../../infra/src/peer/x509.ts";

const [mode, dir, ...rest] = process.argv.slice(2);
const say = (o: unknown): void => { process.stdout.write(JSON.stringify(o) + "\n"); };
const creds = (): PeerCredentials => ({ keyPem: readFileSync(join(dir, "key.pem"), "utf8"), certPem: readFileSync(join(dir, "cert.pem"), "utf8") });
const myFingerprint = (): string => certFingerprint(pemToDer(creds().certPem));

function readBody(stream: http2.Http2Stream): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    stream.on("data", (c: Buffer) => parts.push(c));
    stream.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    stream.on("error", reject);
  });
}

function request(session: http2.ClientHttp2Session, method: string, path: string, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const stream = session.request({ ":method": method, ":path": path });
    let status = 0;
    stream.on("response", (h) => { status = Number(h[":status"]); });
    stream.on("error", reject);
    readBody(stream).then((text) => resolve({ status, body: text }), reject);
    stream.end(body);
  });
}

// What every stream gets answered with: who the TLS layer says the caller is.
function echo(stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders, peer: PeerSessionInfo): void {
  readBody(stream).then((body) => {
    stream.respond({ ":status": 200, "content-type": "application/json" });
    stream.end(JSON.stringify({ server: "node", me: myFingerprint(), you: peer.fingerprint, admission: peer.admission, path: headers[":path"], bodyBytes: body.length }));
  }, () => {});
}

if (mode === "gen") {
  mkdirSync(dir, { recursive: true });
  const id = createSelfSignedIdentity({ commonName: rest[0] });
  writeFileSync(join(dir, "key.pem"), id.keyPem, { mode: 0o600 });
  writeFileSync(join(dir, "cert.pem"), id.certPem, { mode: 0o600 });
  say({ fingerprint: id.fingerprint });
} else if (mode === "certs") {
  for (let i = 0; i < Number(dir); i++) {
    const id = createSelfSignedIdentity({ commonName: i % 2 ? "eos-device" : `device ${i} ü` });
    say({ der: pemToDer(id.certPem).toString("base64"), fingerprint: id.fingerprint });
  }
} else if (mode === "server") {
  const [trusted, refusal] = rest;
  const server = createSecurePeerServer({
    creds: creds(),
    admit: (fp) => (fp === trusted ? { admission: "trusted" } : { admission: "refused", reason: refusal ?? "not-paired" }),
    onStream: (stream, headers, peer) => {
      if (headers[":path"] === "/peer/reverse" && headers[":method"] === "POST") {
        // The host's side of a reverse tunnel: the stream becomes the pipe this
        // side dials TLS + HTTP/2 through, pinned to the device that offered it.
        stream.respond({ ":status": 200 });
        connectSecure({ creds: creds(), expectFingerprint: peer.fingerprint, transport: stream })
          .then((sock) => request(openPeerSession(sock), "POST", "/through-the-tunnel", "x".repeat(300_000)))
          .then((res) => say({ reverse: res }), (e: Error) => say({ reverse: { error: e.message } }));
        return;
      }
      echo(stream, headers, peer);
    },
  });
  const addr = await server.listen(0, "127.0.0.1");
  say({ port: addr.port });
  process.stdin.on("end", () => process.exit(0)).resume();
} else if (mode === "client") {
  const [port, expect, path] = rest;
  try {
    const sock = await connectSecure({ creds: creds(), expectFingerprint: expect, transport: { host: "127.0.0.1", port: Number(port) } });
    const session = openPeerSession(sock);
    let goaway: { code: number; data: string } | null = null;
    session.on("error", () => {});
    session.on("goaway", (code: number, _last: number, data?: Buffer) => { goaway = { code, data: data?.toString("utf8") ?? "" }; });
    const closed = new Promise<void>((r) => session.once("close", () => r()));
    let res: unknown;
    try { res = await request(session, "POST", path, "hello from node"); } catch (e) { res = { error: (e as Error).message }; }
    if (goaway) await closed; else session.close();
    say({ tls: sock.getProtocol(), alpn: sock.alpnProtocol, res, goaway });
  } catch (e) {
    say({ error: e instanceof PeerIdentityError ? "PeerIdentityError" : (e as Error).message });
  }
  process.exit(0);
} else if (mode === "reverse-device") {
  // A device that cannot be dialed: it connects out, then hands the host a
  // tunnel back and serves the host's requests through it.
  const [port, expect] = rest;
  const mine = createSecurePeerServer({ creds: creds(), admit: (fp) => (fp === expect ? { admission: "trusted" } : { admission: "refused" }), onStream: echo });
  const sock = await connectSecure({ creds: creds(), expectFingerprint: expect, transport: { host: "127.0.0.1", port: Number(port) } });
  const session = openPeerSession(sock);
  const stream = session.request({ ":method": "POST", ":path": "/peer/reverse" });
  stream.on("error", () => {});
  stream.once("response", (h) => {
    if (Number(h[":status"]) !== 200) { say({ error: `reverse refused: ${h[":status"]}` }); process.exit(1); }
    mine.accept(stream);
    say({ offered: true });
  });
  process.stdin.on("end", () => process.exit(0)).resume();
} else {
  throw new Error(`unknown mode ${mode}`);
}
