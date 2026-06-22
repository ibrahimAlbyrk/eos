// RESUME — warm reconnect, server side (§2.3). PSK-(EC)DHE: no P-256 signature,
// no Face ID. The device proves possession of the resumption PSK via a keyed
// binder; both sides mix the fresh ephemeral DH AND the PSK into the traffic
// keys, so resume is forward-secret and ticket-bound. A resumed session is
// read+lowrisk ONLY (RESUME_CAPS) — high-risk stays gated by the capability
// check in dispatch (§7.3), independent of any Enclave key the device holds.

import { randomBytes } from "node:crypto";
import {
  hash, keyedHash, kdf, kxKeypair, kxSession, makeNonce, aeadSeal, Dir,
} from "./crypto.ts";
import { constantTimeEqual } from "../shared/constant-time.ts";
import { RemoteSessionCodec } from "./session.ts";
import { RESUME_CAPS, type TicketStore } from "./tickets.ts";
import { ResumeFrameSchema, type ResumeOk, type RemoteErrorCode } from "../../contracts/src/remote.ts";

const b64u = (b: Buffer): string => b.toString("base64url");
const unb64u = (s: string): Buffer => Buffer.from(s, "base64url");
const ascii = (s: string): Buffer => Buffer.from(s, "ascii");

export interface ResumeContext {
  room: string;
  clientId: Buffer;
}

export interface ResumeDeps {
  tickets: TicketStore;
  now: () => number;
}

export type ResumeResult =
  | { kind: "complete"; codec: RemoteSessionCodec; devId: string; frame: ResumeOk }
  | { kind: "error"; code: RemoteErrorCode };

export function handleResume(deps: ResumeDeps, ctx: ResumeContext, frameIn: unknown): ResumeResult {
  const parsed = ResumeFrameSchema.safeParse(frameIn);
  if (!parsed.success) return { kind: "error", code: "AUTH_FAILED" };
  const f = parsed.data;
  const ePubC = unb64u(f.ePubC);
  const nC = unb64u(f.nC);
  if (ePubC.length !== 32 || nC.length !== 16) return { kind: "error", code: "AUTH_FAILED" };

  const peeked = deps.tickets.peek(f.ticketId, deps.now());
  if (!peeked.ok) return { kind: "error", code: peeked.code };
  const rec = peeked.record;
  const psk = rec.psk;

  // Verify the device binder BEFORE consuming, so a bad binder doesn't burn a
  // live ticket (§2.3).
  const binderC = keyedHash(psk, ascii("eos/v1 resume binderC"), rec.ticketId, ePubC, nC);
  if (!constantTimeEqual(b64u(binderC), f.binder)) return { kind: "error", code: "AUTH_FAILED" };
  deps.tickets.markConsumed(rec);

  const eph = kxKeypair();
  const ePubS = eph.pub;
  const nS = randomBytes(16);
  const { kC2s, kS2c } = kxSession("server", ePubS, eph.sec, ePubC);

  const th = hash(rec.ticketId, ePubC, nC, ePubS, nS);
  const thWithKx = hash(th, kC2s, kS2c);
  const kC2sFinal = kdf(psk, "eos/v1 resume data c2s", thWithKx);
  const kS2cFinal = kdf(psk, "eos/v1 resume data s2c", thWithKx);

  const binderS = keyedHash(psk, ascii("eos/v1 resume binderS"), rec.ticketId, ePubS, nS, ePubC);

  // Fresh ticket of the same family, sealed under the DEDICATED key so it never
  // shares a (key, nonce) with the first s2c data frame (§2.3).
  const { client: newTicket } = deps.tickets.rotate(rec, deps.now());
  const kResumeTicket = kdf(psk, "eos/v1 resume ticket", thWithKx);
  const encTicket = aeadSeal(kResumeTicket, makeNonce(0, Dir.s2c, 0n), Buffer.alloc(0), Buffer.from(JSON.stringify(newTicket), "utf8"));

  const codec = new RemoteSessionCodec({
    clientId: ctx.clientId, room: ctx.room, devId: rec.devId, caps: [...RESUME_CAPS],
    sessionTH: thWithKx, keys: { kC2sFinal, kS2cFinal },
  });

  const frame: ResumeOk = {
    v: 1, t: "resume-ok", ePubS: b64u(ePubS), nS: b64u(nS), binder: b64u(binderS), encTicket: b64u(encTicket),
  };
  return { kind: "complete", codec, devId: rec.devId, frame };
}
