// E2E crypto primitives for the iOS remote edge — protocol spec §1 (LOCKED).
//
// Two halves, each a single identical implementation per platform (§1.1):
//   * libsodium (sodium-native) for ephemeral DH (crypto_kx), KDF/transcript
//     hashing (BLAKE2b via crypto_generichash), and AEAD
//     (XChaCha20-Poly1305-IETF). Same C library on both ends → byte-identical.
//   * Node built-in `crypto` for the P-256 ECDSA static identity (Secure Enclave
//     forces P-256 on the device; the Mac key is P-256 too for symmetry).
//
// Every byte layout here is fixed by the spec and cross-checked against the
// committed golden fixture (docs/vectors/ios-remote-v1/) — see the fixture test.

import sodium from "sodium-native";
import { createSign, createVerify, createPublicKey, createPrivateKey, type KeyObject } from "node:crypto";

export const KEY_BYTES = 32;
export const NONCE_BYTES = 24; // XChaCha20-Poly1305-IETF npub
export const TAG_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES; // 16
export const TH_BYTES = 32;
export const SEC1_POINT_BYTES = 65; // 0x04 ‖ X(32) ‖ Y(32)
export const P256_SIG_BYTES = 64; // raw r‖s (IEEE-P1363)

export const Dir = { c2s: 0x00, s2c: 0x01 } as const;
export type Dir = (typeof Dir)[keyof typeof Dir];

// ---- BLAKE2b (crypto_generichash) ------------------------------------------

// Unkeyed BLAKE2b-256 over the concatenation of parts. Used for transcript
// hashes TH (§1.4).
export function hash(...parts: Buffer[]): Buffer {
  const out = Buffer.alloc(TH_BYTES);
  sodium.crypto_generichash(out, Buffer.concat(parts));
  return out;
}

// Keyed BLAKE2b-256 (32-byte key). Used for the KDF (§1.4), otsProof (§2.1),
// and resume binders (§2.3).
export function keyedHash(key: Buffer, ...parts: Buffer[]): Buffer {
  const out = Buffer.alloc(TH_BYTES);
  sodium.crypto_generichash(out, Buffer.concat(parts), key);
  return out;
}

// KDF(key, label, transcriptHash) = crypto_generichash(32, in=label‖TH, key=key)
// (§1.4). label = ASCII bytes, no NUL; transcriptHash = 32 raw bytes; order is
// label THEN transcriptHash.
export function kdf(key: Buffer, label: string, transcriptHash: Buffer): Buffer {
  return keyedHash(key, Buffer.from(label, "ascii"), transcriptHash);
}

// ---- Ephemeral DH (crypto_kx, role-fixed) ----------------------------------

export interface KxKeyPair {
  pub: Buffer; // 32
  sec: Buffer; // 32
}

export function kxKeypair(): KxKeyPair {
  const pub = Buffer.alloc(sodium.crypto_kx_PUBLICKEYBYTES);
  const sec = Buffer.alloc(sodium.crypto_kx_SECRETKEYBYTES);
  sodium.crypto_kx_keypair(pub, sec);
  return { pub, sec };
}

// Role-fixed session-key agreement (§1.3). Returns the two directional keys
// regardless of side so callers name them by direction, not by rx/tx:
//   K_c2s (device→Mac) = client tx = server rx
//   K_s2c (Mac→device) = client rx = server tx
export function kxSession(
  side: "client" | "server",
  ePub: Buffer,
  eSec: Buffer,
  otherEPub: Buffer,
): { kC2s: Buffer; kS2c: Buffer } {
  const rx = Buffer.alloc(sodium.crypto_kx_SESSIONKEYBYTES);
  const tx = Buffer.alloc(sodium.crypto_kx_SESSIONKEYBYTES);
  if (side === "client") {
    sodium.crypto_kx_client_session_keys(rx, tx, ePub, eSec, otherEPub);
    return { kC2s: tx, kS2c: rx };
  }
  sodium.crypto_kx_server_session_keys(rx, tx, ePub, eSec, otherEPub);
  return { kC2s: rx, kS2c: tx };
}

// ---- AEAD nonce + AAD (§1.5, §4.1) -----------------------------------------

// nonce = epoch(1) ‖ dir(1) ‖ seq(8 BE) ‖ 0x00 × 14  (24 bytes)
export function makeNonce(epoch: number, dir: Dir, seq: bigint): Buffer {
  const n = Buffer.alloc(NONCE_BYTES);
  n.writeUInt8(epoch & 0xff, 0);
  n.writeUInt8(dir & 0xff, 1);
  n.writeBigUInt64BE(seq, 2);
  return n;
}

// AAD = ver(1) ‖ epoch(1) ‖ dir(1) ‖ seq(8 BE) ‖ roomLen(1) ‖ room ‖ clientId(16)
// — exactly the outer-envelope routing fields (§4.1), so a malicious relay
// cannot tamper with routing undetected. epoch/dir/seq MUST match the nonce.
export function makeAad(
  ver: number,
  epoch: number,
  dir: Dir,
  seq: bigint,
  room: string,
  clientId: Buffer,
): Buffer {
  const roomBytes = Buffer.from(room, "ascii");
  if (roomBytes.length > 0xff) throw new Error("room exceeds 255 bytes");
  if (clientId.length !== 16) throw new Error("clientId must be 16 bytes");
  const head = Buffer.alloc(12);
  head.writeUInt8(ver & 0xff, 0);
  head.writeUInt8(epoch & 0xff, 1);
  head.writeUInt8(dir & 0xff, 2);
  head.writeBigUInt64BE(seq, 3);
  head.writeUInt8(roomBytes.length, 11);
  return Buffer.concat([head, roomBytes, clientId]);
}

// ---- AEAD seal/open (XChaCha20-Poly1305-IETF, combined mode) ---------------

// Output is encrypted-bytes ‖ tag(16) — libsodium's combined mode appends the
// tag (§1.5). This is the on-wire `data`-frame payload.
export function aeadSeal(key: Buffer, nonce: Buffer, aad: Buffer, plaintext: Buffer): Buffer {
  const out = Buffer.alloc(plaintext.length + TAG_BYTES);
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(out, plaintext, aad, null, nonce, key);
  return out;
}

// Returns the plaintext, or null on any AEAD/AAD/nonce failure (caller maps to
// DECRYPT_FAIL). Never throws on a bad tag.
export function aeadOpen(key: Buffer, nonce: Buffer, aad: Buffer, ciphertext: Buffer): Buffer | null {
  if (ciphertext.length < TAG_BYTES) return null;
  const out = Buffer.alloc(ciphertext.length - TAG_BYTES);
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(out, null, ciphertext, aad, nonce, key);
    return out;
  } catch {
    return null;
  }
}

// ---- P-256 static identity (Node built-in crypto) --------------------------

// SPKI DER prefix for an uncompressed P-256 public point (§1.2). Wrapping the
// raw 65-byte SEC1 point with this yields a DER SubjectPublicKeyInfo that
// createPublicKey accepts.
const P256_SPKI_PREFIX = Buffer.from(
  "3059301306072a8648ce3d020106082a8648ce3d030107034200",
  "hex",
);

// Export a public KeyObject to the LOCKED 65-byte SEC1 uncompressed point.
export function p256PubToSec1(pub: KeyObject): Buffer {
  const der = pub.export({ type: "spki", format: "der" });
  // The raw point is the trailing 65 bytes of the SPKI BIT STRING.
  return Buffer.from(der.subarray(der.length - SEC1_POINT_BYTES));
}

// Import a raw 65-byte SEC1 point into a public KeyObject.
export function p256PubFromSec1(point: Buffer): KeyObject {
  if (point.length !== SEC1_POINT_BYTES || point[0] !== 0x04) {
    throw new Error("expected 65-byte uncompressed SEC1 point");
  }
  const der = Buffer.concat([P256_SPKI_PREFIX, point]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

// ECDSA-P256-SHA256 sign → raw r‖s 64 bytes (IEEE-P1363, never DER) (§1.2).
// The caller passes the raw message bytes (label-prefixed transcript binding);
// ECDSA hashes with SHA-256 internally.
export function p256Sign(priv: KeyObject, message: Buffer): Buffer {
  const s = createSign("sha256");
  s.update(message);
  s.end();
  return s.sign({ key: priv, dsaEncoding: "ieee-p1363" });
}

export function p256Verify(pub: KeyObject, message: Buffer, sig: Buffer): boolean {
  const v = createVerify("sha256");
  v.update(message);
  v.end();
  return v.verify({ key: pub, dsaEncoding: "ieee-p1363" }, sig);
}

export function p256PrivFromPem(pem: string): KeyObject {
  return createPrivateKey(pem);
}
