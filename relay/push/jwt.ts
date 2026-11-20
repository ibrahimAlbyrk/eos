// The APNs provider token: an ES256 JWT over the operator's .p8 key. Apple refuses a token
// older than an hour and throttles one made more often than every 20 minutes, so one token
// is reused for 50 minutes.
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

const REUSE_MS = 50 * 60 * 1000;

export class ProviderToken {
  private readonly key: KeyObject;
  private readonly keyId: string;
  private readonly teamId: string;
  private readonly now: () => number;
  private current: { jwt: string; madeMs: number } | null = null;

  constructor(keyPath: string, keyId: string, teamId: string, now: () => number) {
    this.key = createPrivateKey(readFileSync(keyPath));
    this.keyId = keyId;
    this.teamId = teamId;
    this.now = now;
  }

  get(): string {
    const nowMs = this.now();
    if (!this.current || nowMs - this.current.madeMs >= REUSE_MS) {
      this.current = { jwt: this.make(nowMs), madeMs: nowMs };
    }
    return this.current.jwt;
  }

  private make(nowMs: number): string {
    const header = base64url({ alg: "ES256", kid: this.keyId });
    const claims = base64url({ iss: this.teamId, iat: Math.floor(nowMs / 1000) });
    const input = `${header}.${claims}`;
    // JOSE wants the raw r||s signature, not DER.
    const signature = sign("sha256", Buffer.from(input), { key: this.key, dsaEncoding: "ieee-p1363" });
    return `${input}.${signature.toString("base64url")}`;
  }
}

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
