// The update feed's signature: Ed25519 over the pointer's JSON, verbatim.
// Public keys travel as their JWK `x` (base64url of the 32 raw bytes); more
// than one is accepted so a key can be rotated without stranding old installs.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

import type { UpdateSignature } from "../../../core/src/ports/Updates.ts";

export class Ed25519UpdateSignature implements UpdateSignature {
  private readonly keys: KeyObject[];

  constructor(publicKeys: readonly string[]) {
    this.keys = publicKeys.map((x) => createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" }));
  }

  verify(payload: string, signature: string): boolean {
    const sig = Buffer.from(signature, "base64");
    if (sig.length !== 64) return false;
    const data = Buffer.from(payload, "utf8");
    return this.keys.some((key) => verify(null, data, key, sig));
  }
}

// The private key is PKCS#8 DER, base64 — what the release Mac keeps in its Keychain.
export function signUpdatePayload(payload: string, privateKey: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" });
  return sign(null, Buffer.from(payload, "utf8"), key).toString("base64");
}

export function generateUpdateSigningKey(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  return {
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKey: String(jwk.x),
  };
}

// The public half of a stored private key, to check it is the one the app trusts.
export function publicKeyOf(privateKey: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" });
  return String(createPublicKey(key).export({ format: "jwk" }).x);
}
