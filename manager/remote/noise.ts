// Noise_IK_25519_XChaChaPoly_BLAKE2b — the SINGLE handshake for the iOS remote
// edge (connection v2, docs/ios-remote-connection-v2.md). WireGuard's model: one
// static X25519 keypair per side, a 2-message IK handshake used byte-identically
// on first-connect (enroll, gated by a one-time token in payload-1) and on every
// reconnect (match the device static against the persisted allowlist).
//
// IK pattern (noiseprotocol.org):
//   <- s                  (responder static pre-known by the initiator: the QR)
//   -> e, es, s, ss       (msg 1: device → Mac; device static is sent encrypted)
//   <- e, ee, se          (msg 2: Mac → device)
//
// The cipher suite is not a registered Noise name but a valid instantiation over
// Eos's libsodium primitives (X25519 / BLAKE2b / XChaCha20-Poly1305) — both ends
// run THIS state machine, so byte-agreement is guaranteed and pinned by the
// golden fixture (docs/vectors/ios-remote-v2/). Off-the-shelf Noise libraries
// hardcode ChaChaPoly's 12-byte nonce, so they cannot produce these bytes; the
// shared hand-rolled state machine + fixture is what makes Swift↔Node interop
// exact.

import { hash, aeadSeal, aeadOpen, x25519, x25519Keypair, type X25519KeyPair } from "./crypto.ts";

export const PROTOCOL_NAME = "Noise_IK_25519_XChaChaPoly_BLAKE2b";
export const PROLOGUE = "eos-remote-v2";
export const DHLEN = 32;
export const HASHLEN = 32;
export const TAGLEN = 16;
const BLAKE2B_BLOCK = 128; // BLAKE2b block size, for HMAC

export { x25519Keypair };
export type { X25519KeyPair };

// ---- BLAKE2b-based HMAC + HKDF (Noise §4.3, §5.1) --------------------------
// Noise's HKDF is built on HMAC(HASH). For BLAKE2b that is the standard HMAC
// construction (NOT libsodium keyed-BLAKE2b), block size 128, 32-byte output.

function hmacBlake2b(key: Buffer, data: Buffer): Buffer {
  let k = key;
  if (k.length > BLAKE2B_BLOCK) k = hash(k);
  const block = Buffer.alloc(BLAKE2B_BLOCK);
  k.copy(block);
  const ipad = Buffer.alloc(BLAKE2B_BLOCK);
  const opad = Buffer.alloc(BLAKE2B_BLOCK);
  for (let i = 0; i < BLAKE2B_BLOCK; i++) {
    ipad[i] = block[i] ^ 0x36;
    opad[i] = block[i] ^ 0x5c;
  }
  return hash(opad, hash(ipad, data));
}

// HKDF(chaining_key, ikm, 2) → (output1, output2) (Noise §4.3).
function hkdf2(ck: Buffer, ikm: Buffer): [Buffer, Buffer] {
  const tempKey = hmacBlake2b(ck, ikm);
  const o1 = hmacBlake2b(tempKey, Buffer.from([0x01]));
  const o2 = hmacBlake2b(tempKey, Buffer.concat([o1, Buffer.from([0x02])]));
  return [o1, o2];
}

// ---- Handshake AEAD nonce ---------------------------------------------------
// Per-CipherState 64-bit counter n (resets to 0 on each MixKey). XChaCha needs a
// 24-byte npub; we place n little-endian in the LAST 8 bytes, the rest zero.
// Distinct from the transport nonce (crypto.makeNonce) and from a fresh key, so
// no (key, nonce) reuse.
function noiseNonce(n: bigint): Buffer {
  const npub = Buffer.alloc(24);
  npub.writeBigUInt64LE(n, 16);
  return npub;
}

// ---- CipherState (Noise §5.1) ----------------------------------------------

class CipherState {
  private k: Buffer | null = null;
  private n = 0n;

  initializeKey(k: Buffer | null): void { this.k = k; this.n = 0n; }
  hasKey(): boolean { return this.k !== null; }

  encryptWithAd(ad: Buffer, plaintext: Buffer): Buffer {
    if (!this.k) return plaintext;
    const ct = aeadSeal(this.k, noiseNonce(this.n), ad, plaintext);
    this.n++;
    return ct;
  }

  // Returns null on AEAD failure (caller aborts the handshake).
  decryptWithAd(ad: Buffer, ciphertext: Buffer): Buffer | null {
    if (!this.k) return ciphertext;
    const pt = aeadOpen(this.k, noiseNonce(this.n), ad, ciphertext);
    if (pt === null) return null;
    this.n++;
    return pt;
  }
}

// ---- SymmetricState (Noise §5.2) -------------------------------------------

class SymmetricState {
  ck: Buffer;
  h: Buffer;
  readonly cs = new CipherState();

  constructor() {
    const name = Buffer.from(PROTOCOL_NAME, "ascii");
    // len(name) (34) > HASHLEN (32) ⇒ h = HASH(name).
    this.h = name.length <= HASHLEN
      ? Buffer.concat([name, Buffer.alloc(HASHLEN - name.length)])
      : hash(name);
    this.ck = Buffer.from(this.h);
  }

  mixHash(data: Buffer): void { this.h = hash(this.h, data); }

  mixKey(ikm: Buffer): void {
    const [ck, tempK] = hkdf2(this.ck, ikm);
    this.ck = ck;
    this.cs.initializeKey(tempK);
  }

  encryptAndHash(plaintext: Buffer): Buffer {
    const ct = this.cs.encryptWithAd(this.h, plaintext);
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ciphertext: Buffer): Buffer | null {
    const pt = this.cs.decryptWithAd(this.h, ciphertext);
    if (pt === null) return null;
    this.mixHash(ciphertext);
    return pt;
  }

  // Final transport keys: HKDF(ck, "", 2). (k1, k2) — order is role-fixed by the
  // caller into c2s / s2c.
  split(): [Buffer, Buffer] {
    return hkdf2(this.ck, Buffer.alloc(0));
  }
}

export interface SplitKeys {
  kC2sFinal: Buffer; // device→Mac transport key (initiator send / responder recv)
  kS2cFinal: Buffer; // Mac→device transport key (initiator recv / responder send)
  sessionTH: Buffer; // final handshake hash h — binds the session
}

// ---- IK initiator (device / iOS) -------------------------------------------

export class NoiseInitiator {
  private readonly sym = new SymmetricState();
  private readonly s: X25519KeyPair; // device static
  private readonly rs: Buffer; // Mac static public (pinned, from the QR)
  private e!: X25519KeyPair; // device ephemeral
  private re!: Buffer; // Mac ephemeral public

  // testEphemeral is injected only by the fixture/tests for determinism.
  constructor(deviceStatic: X25519KeyPair, macStaticPub: Buffer, testEphemeral?: X25519KeyPair) {
    this.s = deviceStatic;
    this.rs = macStaticPub;
    this.sym.mixHash(Buffer.from(PROLOGUE, "ascii"));
    this.sym.mixHash(this.rs); // pre-message: responder static
    if (testEphemeral) this.e = testEphemeral;
  }

  // Msg 1: e, es, s, ss  +  encrypted payload (payload1).
  writeMessage1(payload1: Buffer): Buffer {
    if (!this.e) this.e = x25519Keypair();
    this.sym.mixHash(this.e.pub);
    this.sym.mixKey(x25519(this.e.sec, this.rs)); // es
    const ctS = this.sym.encryptAndHash(this.s.pub); // s (encrypted device static)
    this.sym.mixKey(x25519(this.s.sec, this.rs)); // ss
    const ctP = this.sym.encryptAndHash(payload1);
    return Buffer.concat([this.e.pub, ctS, ctP]);
  }

  // Msg 2: e, ee, se  +  encrypted payload (payload2). Returns null on AEAD fail
  // (auth rejected / tampered).
  readMessage2(msg2: Buffer): { payload2: Buffer; keys: SplitKeys } | null {
    if (msg2.length < DHLEN) return null;
    this.re = msg2.subarray(0, DHLEN);
    this.sym.mixHash(this.re);
    this.sym.mixKey(x25519(this.e.sec, this.re)); // ee
    this.sym.mixKey(x25519(this.s.sec, this.re)); // se
    const payload2 = this.sym.decryptAndHash(msg2.subarray(DHLEN));
    if (payload2 === null) return null;
    const [k1, k2] = this.sym.split();
    return { payload2, keys: { kC2sFinal: k1, kS2cFinal: k2, sessionTH: this.sym.h } };
  }
}

// ---- IK responder (Mac / daemon) -------------------------------------------

export class NoiseResponder {
  private readonly sym = new SymmetricState();
  private readonly s: X25519KeyPair; // Mac static
  private e!: X25519KeyPair; // Mac ephemeral
  private re!: Buffer; // device ephemeral public
  private rsPub!: Buffer; // device static public (decrypted from msg 1)

  constructor(macStatic: X25519KeyPair, testEphemeral?: X25519KeyPair) {
    this.s = macStatic;
    this.sym.mixHash(Buffer.from(PROLOGUE, "ascii"));
    this.sym.mixHash(this.s.pub); // pre-message: responder static
    if (testEphemeral) this.e = testEphemeral;
  }

  // Read msg 1; on success returns the device static public (for allowlist
  // record/match) and payload1. Returns null on any AEAD failure.
  readMessage1(msg1: Buffer): { deviceStaticPub: Buffer; payload1: Buffer } | null {
    if (msg1.length < DHLEN + DHLEN + TAGLEN) return null;
    this.re = msg1.subarray(0, DHLEN);
    this.sym.mixHash(this.re);
    this.sym.mixKey(x25519(this.s.sec, this.re)); // es
    const ctS = msg1.subarray(DHLEN, DHLEN + DHLEN + TAGLEN); // encrypted static (48)
    const rsPub = this.sym.decryptAndHash(ctS);
    if (rsPub === null || rsPub.length !== DHLEN) return null;
    this.rsPub = rsPub;
    this.sym.mixKey(x25519(this.s.sec, this.rsPub)); // ss
    const payload1 = this.sym.decryptAndHash(msg1.subarray(DHLEN + DHLEN + TAGLEN));
    if (payload1 === null) return null;
    return { deviceStaticPub: this.rsPub, payload1 };
  }

  // Write msg 2 and finalize transport keys. Call only after a successful
  // readMessage1.
  writeMessage2(payload2: Buffer): { msg2: Buffer; keys: SplitKeys } {
    if (!this.e) this.e = x25519Keypair();
    this.sym.mixHash(this.e.pub);
    this.sym.mixKey(x25519(this.e.sec, this.re)); // ee
    this.sym.mixKey(x25519(this.e.sec, this.rsPub)); // se
    const ctP = this.sym.encryptAndHash(payload2);
    const msg2 = Buffer.concat([this.e.pub, ctP]);
    const [k1, k2] = this.sym.split();
    return { msg2, keys: { kC2sFinal: k1, kS2cFinal: k2, sessionTH: this.sym.h } };
  }
}
