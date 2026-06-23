// Mac static identity + persisted device allowlist (connection v2 §3).
//
//   ~/.eos/remote/mac-static.key            the Mac's long-term X25519 keypair (0600)
//   ~/.eos/remote/devices/<relayDeviceId>.json  one enrolled device (0600)
//
// The devices/ directory is the SINGLE SOURCE OF TRUTH for who may connect; it
// survives daemon restart (there is no in-memory session state whose loss
// matters — the next handshake just runs fresh, WireGuard-after-reboot). The
// relay allowlist is a re-announced cache of this (§4.3), so it can never drift.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { x25519Keypair, x25519Pub, type X25519KeyPair } from "./crypto.ts";
import { relayDeviceId } from "./identity.ts";
import { errMsg } from "../../contracts/src/util.ts";

const SECRET_MODE = 0o600;

export function sha256Hex(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

export interface DeviceRecord {
  relayDeviceId: string; // b64u(BLAKE2b-256(deviceStaticPub)) — the file key + relay-admission id
  deviceStaticPub: string; // hex of the 32-byte X25519 device static public key
  label: string;
  enrolledAt: number;
}

// The Mac's long-term X25519 static identity (the Noise responder static). The
// device pins its public key from the QR; the private key never leaves the Mac.
export class MacIdentity {
  private readonly keyPath: string;
  private readonly kp: X25519KeyPair;

  constructor(remoteDir: string) {
    this.keyPath = join(remoteDir, "mac-static.key");
    mkdirSync(remoteDir, { recursive: true });
    if (existsSync(this.keyPath)) {
      const sec = Buffer.from(readFileSync(this.keyPath, "utf8").trim(), "hex");
      this.kp = { sec, pub: x25519Pub(sec) };
    } else {
      this.kp = x25519Keypair();
      writeFileSync(this.keyPath, this.kp.sec.toString("hex") + "\n", { mode: SECRET_MODE });
    }
  }

  keypair(): X25519KeyPair { return this.kp; }
  publicKey(): Buffer { return this.kp.pub; }
}

// Enrolled-device allowlist. One JSON file per device under <remoteDir>/devices/,
// keyed by the stable relayDeviceId (derived from the device static key).
export class DeviceKeyring {
  private readonly dir: string;

  constructor(remoteDir: string) {
    this.dir = join(remoteDir, "devices");
    mkdirSync(this.dir, { recursive: true });
  }

  private fileFor(relayDeviceId: string): string {
    // relayDeviceId is b64u (A-Za-z0-9-_); refuse anything that could escape the dir.
    if (!/^[A-Za-z0-9._-]+$/.test(relayDeviceId)) throw new Error(`invalid relayDeviceId: ${relayDeviceId}`);
    return join(this.dir, `${relayDeviceId}.json`);
  }

  // Enroll (TOFU record) a device from its static public key (§5.2). Idempotent
  // re-enroll just refreshes the record.
  record(deviceStaticPub: Buffer, label: string, now: number): DeviceRecord {
    const id = relayDeviceId(deviceStaticPub);
    const rec: DeviceRecord = { relayDeviceId: id, deviceStaticPub: deviceStaticPub.toString("hex"), label, enrolledAt: now };
    writeFileSync(this.fileFor(id), JSON.stringify(rec, null, 2) + "\n", { mode: SECRET_MODE });
    return rec;
  }

  // Match a presented device static key against the allowlist (§5.1). Returns the
  // record if this exact key is enrolled, else null.
  findByStaticPub(deviceStaticPub: Buffer): DeviceRecord | null {
    const id = relayDeviceId(deviceStaticPub);
    const path = this.fileFor(id);
    if (!existsSync(path)) return null;
    let rec: DeviceRecord;
    try {
      rec = JSON.parse(readFileSync(path, "utf8")) as DeviceRecord;
    } catch (e) {
      throw new Error(`corrupt device record ${id}: ${errMsg(e)}`);
    }
    // The filename is derived from the key, but verify the stored key matches the
    // presented one byte-for-byte (defense against a tampered file).
    return rec.deviceStaticPub === deviceStaticPub.toString("hex") ? rec : null;
  }

  list(): DeviceRecord[] {
    const out: DeviceRecord[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try { out.push(JSON.parse(readFileSync(join(this.dir, f), "utf8")) as DeviceRecord); } catch { /* skip corrupt */ }
    }
    return out;
  }

  // Revocation: remove the device's static key from the allowlist. Returns true
  // if a record was removed.
  revoke(relayDeviceId: string): boolean {
    const path = this.fileFor(relayDeviceId);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
  }

  // The relay-admission allowlist = SHA-256 of every enrolled relayDeviceId. The
  // relay hashes the value a device presents at join and checks membership, so it
  // stays a blind pipe and the admitted value never has to be secret (§4.2).
  //
  // Skip any record without a valid relayDeviceId: a leftover v1 record (keyed by a
  // devId UUID, no relayDeviceId field) must be IGNORED, not crash sha256Hex — this
  // runs at relay-register time, so a throw here would leave the room unregistered
  // and every device join would get ROOM_NOT_FOUND. v1 devices simply re-pair.
  admissionHashes(): string[] {
    return this.list()
      .filter((d) => typeof d.relayDeviceId === "string" && d.relayDeviceId.length > 0)
      .map((d) => sha256Hex(d.relayDeviceId));
  }
}
