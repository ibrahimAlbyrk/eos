import { createCipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from "node:crypto";

// A hook event is sealed on arrival to the inbox's X25519 key (07 §4.7), so the relay keeps
// only ciphertext. `sealed` = ephemeral public 32 ‖ nonce 12 ‖ ciphertext ‖ tag 16. The byte
// format is shared with the Mac (`eos-relay/src/hooks/seal.rs`) through
// `fixtures/relay/hook-seal.json`.

export const SEAL_INFO = "eos-hook-seal-v1";
const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

export type SealParts = { ephemeralSecret: Buffer; nonce: Buffer };

export function publicKeyFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw.toString("base64url") }, format: "jwk" });
}

function rawPublic(key: KeyObject): Buffer {
  return Buffer.from(String(key.export({ format: "jwk" }).x), "base64url");
}

function ephemeral(secret: Buffer | null): { privateKey: KeyObject; publicRaw: Buffer } {
  const privateKey = secret
    ? createPrivateKey({ key: Buffer.concat([PKCS8_X25519_PREFIX, secret]), format: "der", type: "pkcs8" })
    : generateKeyPairSync("x25519").privateKey;
  return { privateKey, publicRaw: rawPublic(createPublicKey(privateKey)) };
}

// `parts` fixes the ephemeral key and nonce; only the vectors pass it.
export function seal(recipient: Buffer, plaintext: Buffer, parts?: SealParts): Buffer {
  const { privateKey, publicRaw } = ephemeral(parts?.ephemeralSecret ?? null);
  const shared = diffieHellman({ privateKey, publicKey: publicKeyFromRaw(recipient) });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), SEAL_INFO, 32));
  const nonce = parts?.nonce ?? randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([publicRaw, nonce, body, cipher.getAuthTag()]);
}

// A 32-byte X25519 public key the inbox may be sealed to; false for anything else.
export function isPublicKey(raw: Buffer): boolean {
  if (raw.length !== 32) return false;
  try {
    publicKeyFromRaw(raw);
    return true;
  } catch {
    return false;
  }
}
