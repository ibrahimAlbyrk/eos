// SIGMA-I cold handshake — server side (§2.1 PAIRING, §2.2 CONNECT). Realizes
// Noise-XX-equivalent mutual static auth + per-session forward secrecy via an
// explicit construction over crypto_kx (DH) + P-256 ECDSA (identity).
//
// PAIRING enrolls a new device, gated by the one-time QR secret (otsProof).
// CONNECT authenticates an already-enrolled device (Face-ID-fresh) by allowlist
// lookup. Both end by deriving the §2.5 traffic keys and a session whose
// transcript hash TH3 binds step-up (§7.3).
//
// The device side runs the mirror of this and is exercised by the in-process
// integration test; the byte derivations are the ones pinned in the golden
// fixture (docs/vectors/ios-remote-v1/).

import { randomBytes, type KeyObject } from "node:crypto";
import {
  hash, keyedHash, kdf, kxKeypair, kxSession, makeNonce, aeadSeal, aeadOpen, Dir,
  p256Sign, p256Verify, p256PubFromSec1,
} from "./crypto.ts";
import { constantTimeEqual } from "../shared/constant-time.ts";
import { RemoteSessionCodec } from "./session.ts";
import { MacIdentity, DeviceKeyring, sha256Hex } from "./keyring.ts";
import { TicketStore, type ClientTicket } from "./tickets.ts";
import {
  Hs1Schema, Hs2Schema, Hs3Schema, HsS2Schema, HsC3Schema,
  type Hs1, type Hs2, type Hs3, type HsMode, type RemoteErrorCode,
} from "../../contracts/src/remote.ts";

// Capabilities a cold (Face-ID) session holds. "mutate" gates the local
// ui-token supply for ✦ routes (§4.5); "highrisk" gates the HIGH tier itself
// (still per-action step-up on top). A resumed session gets neither, so it can
// never reach HIGH even if the device could produce a step-up sig (§2.3, §7.3).
export const COLD_CAPS = ["read", "lowrisk", "mutate", "highrisk"] as const;

const b64u = (b: Buffer): string => b.toString("base64url");
const unb64u = (s: string): Buffer => Buffer.from(s, "base64url");
const ascii = (s: string): Buffer => Buffer.from(s, "ascii");

const LABELS: Record<HsMode, { server: string; client: string }> = {
  pair: { server: "eos/v1 pair server", client: "eos/v1 pair client" },
  connect: { server: "eos/v1 conn server", client: "eos/v1 conn client" },
};

export interface HandshakeContext {
  room: string;
  clientId: Buffer; // assigned before the handshake (join-ack / LAN daemon)
  ots?: Buffer; // PAIRING only: server-side copy of the one-time QR secret
}

export interface HandshakeDeps {
  identity: MacIdentity;
  keyring: DeviceKeyring;
  tickets: TicketStore;
  now: () => number;
  // Mark the one-time pairing secret burned (single-use). Called on a verified
  // PAIR-3 before enrollment; idempotent.
  burnOts?: () => void;
}

// What the transport seals + sends as the first s2c frame after PAIR-3/CONNECT-3.
export interface Welcome {
  bearer: string; // durable per-device relay bearer (b64u 32B)
  bearerHashHex: string; // its sha256 — the relay allowlist entry to add
  ticket: ClientTicket;
}

export type HandshakeResult =
  | { kind: "reply"; frame: Hs2 }
  | { kind: "complete"; codec: RemoteSessionCodec; devId: string; welcome: Welcome }
  | { kind: "error"; code: RemoteErrorCode };

export class HandshakeServer {
  private readonly deps: HandshakeDeps;
  private readonly ctx: HandshakeContext;
  private mode: HsMode = "pair";

  // Carried between step 1 and step 3.
  private ePubC!: Buffer;
  private nC!: Buffer;
  private ePubS!: Buffer;
  private nS!: Buffer;
  private kC2s!: Buffer;
  private kS2c!: Buffer;
  private encS!: Buffer;
  private awaiting: 1 | 3 = 1;

  constructor(deps: HandshakeDeps, ctx: HandshakeContext) {
    this.deps = deps;
    this.ctx = ctx;
  }

  handle(frame: unknown): HandshakeResult {
    if (this.awaiting === 1) {
      const r = Hs1Schema.safeParse(frame);
      if (!r.success) return { kind: "error", code: "AUTH_FAILED" };
      return this.step1(r.data);
    }
    const r = Hs3Schema.safeParse(frame);
    if (!r.success) return { kind: "error", code: "AUTH_FAILED" };
    return this.step3(r.data);
  }

  private step1(f: Hs1): HandshakeResult {
    this.mode = f.mode;
    if (this.mode === "pair" && !this.ctx.ots) return { kind: "error", code: "AUTH_FAILED" };
    this.ePubC = unb64u(f.ePubC);
    this.nC = unb64u(f.nC);
    if (this.ePubC.length !== 32 || this.nC.length !== 16) return { kind: "error", code: "AUTH_FAILED" };

    const eph = kxKeypair();
    this.ePubS = eph.pub;
    this.nS = randomBytes(16);
    const { kC2s, kS2c } = kxSession("server", this.ePubS, eph.sec, this.ePubC);
    this.kC2s = kC2s; this.kS2c = kS2c;

    const th2 = hash(this.ePubC, this.nC, this.ePubS, this.nS);
    const kHsS2c = kdf(kS2c, "eos/v1 hs s2c", th2);
    const sigS = p256Sign(this.deps.identity.privateKey(), Buffer.concat([ascii(LABELS[this.mode].server), th2]));
    const s2 = Buffer.from(JSON.stringify({ iMac: b64u(this.deps.identity.publicSec1()), sigS: b64u(sigS) }), "utf8");
    this.encS = aeadSeal(kHsS2c, makeNonce(0, Dir.s2c, 0n), Buffer.alloc(0), s2);

    this.awaiting = 3;
    const reply: Hs2 = {
      v: 1, t: "hs", step: 2, mode: this.mode,
      ePubS: b64u(this.ePubS), nS: b64u(this.nS), encS: b64u(this.encS),
    };
    return { kind: "reply", frame: reply };
  }

  private step3(f: Hs3): HandshakeResult {
    if (f.mode !== this.mode) return { kind: "error", code: "AUTH_FAILED" };
    const th3 = hash(this.ePubC, this.nC, this.ePubS, this.nS, this.encS);
    const kHsC2s = kdf(this.kC2s, "eos/v1 hs c2s", th3);
    const c3plain = aeadOpen(kHsC2s, makeNonce(0, Dir.c2s, 0n), Buffer.alloc(0), unb64u(f.encC));
    if (!c3plain) return { kind: "error", code: "DECRYPT_FAIL" };
    let c3: unknown;
    try { c3 = JSON.parse(c3plain.toString("utf8")); } catch { return { kind: "error", code: "DECRYPT_FAIL" }; }
    const parsed = HsC3Schema.safeParse(c3);
    if (!parsed.success) return { kind: "error", code: "AUTH_FAILED" };
    const { iDev, devId, label, sigC, ots } = parsed.data;

    // Device identity pubkey from the frame.
    let iDevPub: KeyObject;
    try { iDevPub = p256PubFromSec1(unb64u(iDev)); } catch { return { kind: "error", code: "AUTH_FAILED" }; }

    if (this.mode === "pair") {
      // Prove a human scanned THIS QR and bound it to THIS handshake (§2.1 ⑥/⑧).
      const expected = keyedHash(this.ctx.ots as Buffer, th3);
      if (!constantTimeEqual(b64u(expected), ots)) return { kind: "error", code: "AUTH_FAILED" };
      this.deps.burnOts?.();
    } else {
      // CONNECT: the device must already be enrolled and present the SAME key.
      const rec = this.deps.keyring.find(devId);
      if (!rec) return { kind: "error", code: "AUTH_FAILED" };
      if (!constantTimeEqual(rec.iDevPubSec1, unb64u(iDev).toString("hex"))) {
        return { kind: "error", code: "AUTH_FAILED" };
      }
    }

    // Verify the device's transcript signature (SIGMA-I client side).
    if (!p256Verify(iDevPub, Buffer.concat([ascii(LABELS[this.mode].client), th3]), unb64u(sigC))) {
      return { kind: "error", code: "AUTH_FAILED" };
    }

    // Derive traffic keys; sessionTH = TH3 (what step-up binds to).
    const kC2sFinal = kdf(this.kC2s, "eos/v1 data c2s", th3);
    const kS2cFinal = kdf(this.kS2c, "eos/v1 data s2c", th3);

    // Durable per-device relay bearer + first resumption ticket.
    const bearer = randomBytes(32);
    const bearerHashHex = sha256Hex(bearer);
    const now = this.deps.now();
    const { client: ticket } = this.deps.tickets.issue(devId, now);

    if (this.mode === "pair") {
      this.deps.keyring.enroll({
        devId, label, iDevPubSec1: unb64u(iDev).toString("hex"),
        bearerHashHex, caps: [...COLD_CAPS], addedAt: now,
      });
    } else {
      // Refresh the rotating bearer for the reconnecting device.
      const rec = this.deps.keyring.find(devId);
      if (rec) this.deps.keyring.enroll({ ...rec, bearerHashHex });
    }

    const codec = new RemoteSessionCodec({
      clientId: this.ctx.clientId, room: this.ctx.room, devId, caps: [...COLD_CAPS],
      sessionTH: th3, keys: { kC2sFinal, kS2cFinal },
    });
    return { kind: "complete", codec, devId, welcome: { bearer: b64u(bearer), bearerHashHex, ticket } };
  }
}
