// E2E crypto primitives for the iOS remote edge (connection v2). Everything is
// libsodium (sodium-native) so it is byte-identical to the Swift client (same C
// library compiled twice):
//   * X25519 raw DH (crypto_scalarmult) — the Noise_IK static/ephemeral DH.
//   * BLAKE2b (crypto_generichash) — Noise MixHash + the HMAC/HKDF hash + the
//     relayDeviceId derivation.
//   * XChaCha20-Poly1305-IETF — the Noise handshake AEAD and the transport AEAD.
//
// The Noise state machine that chains these lives in noise.ts; the transport
// frame nonce/AAD layout is protocol §1.5/§4.1, reused unchanged. Byte layouts
// are pinned by the golden fixture (docs/vectors/ios-remote-v2/).

import sodium from "sodium-native";

export const KEY_BYTES = 32;
export const NONCE_BYTES = 24; // XChaCha20-Poly1305-IETF npub
export const TAG_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES; // 16
export const TH_BYTES = 32;

export const Dir = { c2s: 0x00, s2c: 0x01 } as const;
export type Dir = (typeof Dir)[keyof typeof Dir];

// ---- BLAKE2b (crypto_generichash) ------------------------------------------

// Unkeyed BLAKE2b-256 over the concatenation of parts (Noise hash + HKDF hash +
// relayDeviceId).
export function hash(...parts: Buffer[]): Buffer {
  const out = Buffer.alloc(TH_BYTES);
  sodium.crypto_generichash(out, Buffer.concat(parts));
  return out;
}

// ---- X25519 raw DH (Noise IK — crypto_scalarmult) --------------------------

export interface X25519KeyPair {
  pub: Buffer; // 32
  sec: Buffer; // 32
}

// Long-term / ephemeral X25519 keypair (Curve25519). crypto_box_keypair yields
// an X25519 (pk, sk) where pk = scalarmult_base(sk) — the Noise static/ephemeral.
export function x25519Keypair(): X25519KeyPair {
  const pub = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES);
  const sec = Buffer.alloc(sodium.crypto_box_SECRETKEYBYTES);
  sodium.crypto_box_keypair(pub, sec);
  return { pub, sec };
}

export function x25519Pub(sec: Buffer): Buffer {
  const pub = Buffer.alloc(sodium.crypto_scalarmult_BYTES);
  sodium.crypto_scalarmult_base(pub, sec);
  return pub;
}

// Raw X25519: scalarmult(sec, pub) → 32-byte shared secret (the Noise DH()).
export function x25519(sec: Buffer, pub: Buffer): Buffer {
  const out = Buffer.alloc(sodium.crypto_scalarmult_BYTES);
  sodium.crypto_scalarmult(out, sec, pub);
  return out;
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
