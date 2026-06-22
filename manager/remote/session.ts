// Per-session AEAD record codec (§1.5, §2.5, §4). A RemoteSessionCodec is the
// post-handshake state for one paired device: the two directional traffic keys,
// the epoch, the monotonic per-direction seq counters, and the session
// transcript hash (TH3 cold / TH_with_kx resume) that step-up binds to.
//
// seal()  = Mac→device (s2c): JSON inner frame → AEAD → outer envelope bytes.
// open()  = device→Mac (c2s): outer envelope → AEAD-verify → validated frame.
// Transport (WS / relay) is elsewhere; this is pure bytes in / bytes out.

import { Dir, ENVELOPE_VER, FrameType, encodeEnvelope, type Envelope } from "./envelope.ts";
import { makeNonce, makeAad, aeadSeal, aeadOpen } from "./crypto.ts";
import { ClientFrameSchema, type ClientFrame, type RemoteErrorCode } from "../../contracts/src/remote.ts";

export interface SessionTrafficKeys {
  kC2sFinal: Buffer; // device→Mac: used to OPEN incoming
  kS2cFinal: Buffer; // Mac→device: used to SEAL outgoing
}

export type OpenResult =
  | { ok: true; frame: ClientFrame; seq: bigint }
  | { ok: false; code: RemoteErrorCode };

export class RemoteSessionCodec {
  readonly clientId: Buffer;
  readonly room: string;
  readonly devId: string;
  readonly caps: readonly string[];
  readonly sessionTH: Buffer;
  private readonly keys: SessionTrafficKeys;
  private readonly epoch: number;
  private txSeq = 0n; // next s2c seq to emit
  private rxSeq = 0n; // next c2s seq expected

  constructor(args: {
    clientId: Buffer; room: string; devId: string; caps: readonly string[];
    sessionTH: Buffer; keys: SessionTrafficKeys; epoch?: number;
  }) {
    this.clientId = args.clientId;
    this.room = args.room;
    this.devId = args.devId;
    this.caps = args.caps;
    this.sessionTH = args.sessionTH;
    this.keys = args.keys;
    this.epoch = args.epoch ?? 0;
  }

  // Seal one server→client inner frame into its on-wire outer envelope. The AEAD
  // AAD binds the exact routing header, so the relay cannot rewrite routing.
  seal(frame: object): Buffer {
    const seq = this.txSeq++;
    const plaintext = Buffer.from(JSON.stringify(frame), "utf8");
    const nonce = makeNonce(this.epoch, Dir.s2c, seq);
    const aad = makeAad(ENVELOPE_VER, this.epoch, Dir.s2c, seq, this.room, this.clientId);
    const ciphertext = aeadSeal(this.keys.kS2cFinal, nonce, aad, plaintext);
    return encodeEnvelope({
      type: FrameType.data, dir: Dir.s2c, epoch: this.epoch, seq,
      room: this.room, clientId: this.clientId, payload: ciphertext,
    });
  }

  // Open one client→server data envelope: verify direction, seq monotonicity,
  // AEAD/AAD, then validate the inner frame shape.
  open(env: Envelope): OpenResult {
    if (env.dir !== Dir.c2s) return { ok: false, code: "DECRYPT_FAIL" };
    if (env.epoch !== this.epoch) return { ok: false, code: "DECRYPT_FAIL" };
    // Strictly-increasing per-direction seq (§7.2). Behind → replay; ahead → gap.
    if (env.seq < this.rxSeq) return { ok: false, code: "REPLAY" };
    if (env.seq > this.rxSeq) return { ok: false, code: "SEQ_GAP" };
    const nonce = makeNonce(this.epoch, Dir.c2s, env.seq);
    const aad = makeAad(ENVELOPE_VER, this.epoch, Dir.c2s, env.seq, env.room, env.clientId);
    const plaintext = aeadOpen(this.keys.kC2sFinal, nonce, aad, env.payload);
    if (!plaintext) return { ok: false, code: "DECRYPT_FAIL" };
    let parsed: unknown;
    try { parsed = JSON.parse(plaintext.toString("utf8")); } catch { return { ok: false, code: "DECRYPT_FAIL" }; }
    const result = ClientFrameSchema.safeParse(parsed);
    if (!result.success) return { ok: false, code: "DECRYPT_FAIL" };
    this.rxSeq = env.seq + 1n;
    return { ok: true, frame: result.data, seq: env.seq };
  }

  hasCap(cap: string): boolean { return this.caps.includes(cap); }
}
