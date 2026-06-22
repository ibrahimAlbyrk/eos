// Mac static identity + per-device keyring (design §4.3). Files live under
// ~/.eos (mode 0600). Revocation kill-switch #1 (remove the device from the
// keyring → kills its E2E key); kill-switch #2 (drop the bearer hash at the
// relay) lives in the RelayConnector. Pure plumbing — no handshake logic here.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync, createPublicKey, createHash, type KeyObject } from "node:crypto";
import { p256PubToSec1, p256PrivFromPem } from "./crypto.ts";
import { errMsg } from "../../contracts/src/util.ts";

const SECRET_MODE = 0o600;

export interface DeviceRecord {
  devId: string;
  label: string;
  iDevPubSec1: string; // hex of the 65-byte SEC1 device identity public key
  bearerHashHex: string; // sha256(durable per-device bearer), the relay allowlist entry
  caps: string[];
  addedAt: number;
}

export function sha256Hex(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

// The Mac's long-term P-256 identity. Generated once, persisted as PKCS8 PEM
// (file-0600 is acceptable for MVP per design §4.3; Keychain is a later harden).
export class MacIdentity {
  private readonly pemPath: string;
  private priv!: KeyObject;

  constructor(remoteDir: string) {
    this.pemPath = join(remoteDir, "mac-identity.pem");
    mkdirSync(remoteDir, { recursive: true });
    if (existsSync(this.pemPath)) {
      this.priv = p256PrivFromPem(readFileSync(this.pemPath, "utf8"));
    } else {
      const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      writeFileSync(this.pemPath, privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: SECRET_MODE });
      this.priv = privateKey;
    }
  }

  privateKey(): KeyObject { return this.priv; }
  publicSec1(): Buffer { return p256PubToSec1(createPublicKey(this.priv)); }
}

// Enrolled-device store. One JSON file per device under <remoteDir>/devices/.
export class DeviceKeyring {
  private readonly dir: string;

  constructor(remoteDir: string) {
    this.dir = join(remoteDir, "devices");
    mkdirSync(this.dir, { recursive: true });
  }

  private fileFor(devId: string): string {
    // devId is a UUID from the device; refuse anything that could escape the dir.
    if (!/^[A-Za-z0-9._-]+$/.test(devId)) throw new Error(`invalid devId: ${devId}`);
    return join(this.dir, `${devId}.json`);
  }

  enroll(rec: DeviceRecord): void {
    writeFileSync(this.fileFor(rec.devId), JSON.stringify(rec, null, 2) + "\n", { mode: SECRET_MODE });
  }

  find(devId: string): DeviceRecord | null {
    const path = this.fileFor(devId);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as DeviceRecord;
    } catch (e) {
      throw new Error(`corrupt device record ${devId}: ${errMsg(e)}`);
    }
  }

  list(): DeviceRecord[] {
    const out: DeviceRecord[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try { out.push(JSON.parse(readFileSync(join(this.dir, f), "utf8")) as DeviceRecord); } catch { /* skip corrupt */ }
    }
    return out;
  }

  // Revocation kill-switch #1: remove the device's E2E identity. Returns true if
  // a record was removed.
  revoke(devId: string): boolean {
    const path = this.fileFor(devId);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
  }

  // The current relay allowlist = every enrolled device's bearer hash.
  bearerHashAllowlist(): string[] {
    return this.list().map((d) => d.bearerHashHex);
  }
}
