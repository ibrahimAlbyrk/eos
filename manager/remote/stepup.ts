// Step-up sub-protocol (§7.3) — per-action Secure-Enclave authorization for
// HIGH-risk control. A challenge is single-use, short-TTL, and per-session; the
// signed message binds the session transcript hash (the daemon uses its OWN
// stored sessionTH, never a value from the frame), the exact method/path, the
// body hash, the challenge nonce, and a fresh timestamp. This stops both
// in-session replay (nonce) and cross-session transplant (sessionTH).

import { randomBytes } from "node:crypto";
import { hash, p256Verify, p256PubFromSec1 } from "./crypto.ts";
import type { StepUp, RemoteErrorCode } from "../../contracts/src/remote.ts";

const CHALLENGE_TTL_MS = 60_000;
const TS_SKEW_SEC = 60; // step-up `ts` is unix SECONDS (§3.2); `now` is ms

export interface Challenge {
  challengeNonce: string; // b64u(16)
  expiresAt: number;
}

// Per-session issued-challenge ledger. Single-use: a nonce is removed on consume.
export class ChallengeStore {
  private readonly live = new Map<string, number>(); // nonce → expiresAt

  issue(now: number): Challenge {
    const challengeNonce = randomBytes(16).toString("base64url");
    const expiresAt = now + CHALLENGE_TTL_MS;
    this.live.set(challengeNonce, expiresAt);
    return { challengeNonce, expiresAt };
  }

  // Validate + consume in one step (single-use). Returns false if unknown,
  // already-consumed, or expired.
  consume(nonce: string, now: number): boolean {
    const exp = this.live.get(nonce);
    if (exp === undefined) return false;
    this.live.delete(nonce);
    return now <= exp;
  }
}

// §3.4 (resolved): control.body is an OPAQUE JSON STRING on the wire, so the
// hash is over the EXACT transmitted bytes — the device hashes the string it
// sends, the daemon hashes the string it received, with NO re-serialization.
// JSON string decode is exact, so escaping differences never cause a mismatch.
export function bodyHash(bodyStr: string): Buffer {
  return hash(Buffer.from(bodyStr, "utf8"));
}

// Reconstruct the signed message (§3.2). Separators are single 0x0A bytes.
// `body` is the verbatim body STRING (the bytes that travel in control.body).
export function stepUpMessage(args: {
  sessionTH: Buffer; method: string; path: string; body: string;
  challengeNonce: string; ts: number;
}): Buffer {
  const parts = [
    "eos/v1 stepup",
    args.sessionTH.toString("hex"),
    args.method,
    args.path,
    bodyHash(args.body).toString("hex"),
    args.challengeNonce,
    String(args.ts),
  ];
  return Buffer.from(parts.join("\n"), "utf8");
}

export type StepUpVerdict = { ok: true } | { ok: false; code: RemoteErrorCode };

// Full §7.3 step-4 accept set. `iDevPubSec1` is the enrolled device key (hex
// SEC1) — the daemon trusts its keyring, never the frame.
export function verifyStepUp(args: {
  stepUp: StepUp;
  sessionTH: Buffer;
  method: string;
  path: string;
  body: string; // the verbatim control.body string
  iDevPubSec1: string;
  challenges: ChallengeStore;
  now: number;
}): StepUpVerdict {
  const { stepUp, now } = args;
  if (Math.abs(Math.floor(now / 1000) - stepUp.ts) > TS_SKEW_SEC) return { ok: false, code: "STEPUP_INVALID" };
  if (!args.challenges.consume(stepUp.challengeNonce, now)) return { ok: false, code: "STEPUP_INVALID" };
  const msg = stepUpMessage({
    sessionTH: args.sessionTH, method: args.method, path: args.path, body: args.body,
    challengeNonce: stepUp.challengeNonce, ts: stepUp.ts,
  });
  let pub;
  try { pub = p256PubFromSec1(Buffer.from(args.iDevPubSec1, "hex")); } catch { return { ok: false, code: "STEPUP_INVALID" }; }
  const sig = Buffer.from(stepUp.sig, "base64url");
  if (sig.length !== 64) return { ok: false, code: "STEPUP_INVALID" };
  return p256Verify(pub, msg, sig) ? { ok: true } : { ok: false, code: "STEPUP_INVALID" };
}
