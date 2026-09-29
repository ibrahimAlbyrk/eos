// Minimal self-signed X.509 for a peer device identity — no dependencies.
//
// Node can generate keys and sign, but has no API to BUILD a certificate. A
// peer cert only has to carry a public key that TLS proves possession of; we
// never validate chains (both sides pin the fingerprint), so a v3 cert with an
// ECDSA P-256 key, a fixed CN and no extensions is all TLS needs. This file is
// just the DER encoding of that structure; signing is Node's.

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));

function integer(bytes: Buffer): Buffer {
  let b = bytes;
  while (b.length > 1 && b[0] === 0 && (b[1] & 0x80) === 0) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const chunk: number[] = [n & 0x7f];
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

// RFC 5280 §4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050.
function time(d: Date): Buffer {
  const iso = d.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z";
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2), "ascii")) : tlv(0x18, Buffer.from(iso, "ascii"));
}

const ECDSA_WITH_SHA256 = seq(oid("1.2.840.10045.4.3.2"));
const COMMON_NAME = "2.5.4.3";
// RFC 5280 "no well-defined expiration": identities live until re-paired.
const NOT_AFTER = new Date(Date.UTC(9999, 11, 31, 23, 59, 59));

function name(cn: string): Buffer {
  return seq(set(seq(oid(COMMON_NAME), tlv(0x0c, Buffer.from(cn, "utf8")))));
}

export interface PeerIdentityMaterial {
  keyPem: string;
  certPem: string;
  fingerprint: string; // sha256 over the cert DER, lowercase hex
}

export function certFingerprint(certDer: Buffer): string {
  return createHash("sha256").update(certDer).digest("hex");
}

export function pemToDer(pem: string): Buffer {
  return Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
}

function toPem(der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

export function createSelfSignedIdentity(args: { commonName?: string; now?: Date } = {}): PeerIdentityMaterial {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const now = args.now ?? new Date();
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))), // [0] EXPLICIT version v3
    integer(randomBytes(16)),
    ECDSA_WITH_SHA256,
    name(args.commonName ?? "eos-device"),
    seq(time(new Date(now.getTime() - 24 * 60 * 60 * 1000)), time(NOT_AFTER)),
    name(args.commonName ?? "eos-device"),
    publicKey.export({ type: "spki", format: "der" }),
  );
  const signature = sign("sha256", tbs, privateKey as KeyObject);
  const der = seq(tbs, ECDSA_WITH_SHA256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return {
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    certPem: toPem(der),
    fingerprint: certFingerprint(der),
  };
}
