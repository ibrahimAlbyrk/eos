// The sync key and everything derived from it. The key is the account: a relay URL
// plus a 32-byte secret, pasted on each Mac that joins. From the secret come the
// vault id and bearer the relay knows, and the two keys it never sees — one names
// records (HMAC), one seals them (AES-256-GCM, the record key as AAD).

import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";

import type { SyncCrypto } from "../../../core/src/ports/SyncCrypto.ts";

const KEY_PREFIX = "eos-sync1";
const SECRET_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface SyncIdentity {
  readonly relayUrl: string;
  readonly secret: Uint8Array;
}

export function newSyncIdentity(relayUrl: string): SyncIdentity {
  return { relayUrl, secret: new Uint8Array(randomBytes(SECRET_BYTES)) };
}

export function formatSyncKey(id: SyncIdentity): string {
  return [KEY_PREFIX, Buffer.from(id.relayUrl).toString("base64url"), Buffer.from(id.secret).toString("base64url")].join(".");
}

export function parseSyncKey(key: string): SyncIdentity | null {
  const [prefix, url, secret, ...rest] = key.trim().split(".");
  if (prefix !== KEY_PREFIX || !url || !secret || rest.length) return null;
  const relayUrl = Buffer.from(url, "base64url").toString("utf8");
  const bytes = Buffer.from(secret, "base64url");
  if (bytes.length !== SECRET_BYTES || !/^(wss?|https?):\/\/[^\s]+$/.test(relayUrl)) return null;
  return { relayUrl, secret: new Uint8Array(bytes) };
}

export interface SyncKeys {
  readonly vaultId: string;
  readonly authToken: string;
  readonly crypto: SyncCrypto;
}

export function deriveSyncKeys(secret: Uint8Array): SyncKeys {
  const derive = (label: string, length = 32): Buffer =>
    Buffer.from(hkdfSync("sha256", secret, "eos-sync-v1", label, length));
  const encKey = derive("enc");
  const nameKey = derive("record-key");
  return {
    vaultId: derive("vault-id", 16).toString("hex"),
    authToken: derive("auth").toString("base64url"),
    crypto: {
      recordKey: (domain, id) => createHmac("sha256", nameKey).update(`${domain}\0${id}`).digest("hex"),
      seal: (recordKey, plaintext) => {
        const nonce = randomBytes(NONCE_BYTES);
        const cipher = createCipheriv("aes-256-gcm", encKey, nonce);
        cipher.setAAD(Buffer.from(recordKey));
        const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        return new Uint8Array(Buffer.concat([nonce, body, cipher.getAuthTag()]));
      },
      open: (recordKey, sealed) => {
        const buf = Buffer.from(sealed);
        if (buf.length < NONCE_BYTES + TAG_BYTES) throw new Error("sealed record too short");
        const decipher = createDecipheriv("aes-256-gcm", encKey, buf.subarray(0, NONCE_BYTES));
        decipher.setAAD(Buffer.from(recordKey));
        decipher.setAuthTag(buf.subarray(buf.length - TAG_BYTES));
        return new Uint8Array(Buffer.concat([decipher.update(buf.subarray(NONCE_BYTES, buf.length - TAG_BYTES)), decipher.final()]));
      },
      hash: (text) => createHash("sha256").update(text).digest("hex"),
    },
  };
}
