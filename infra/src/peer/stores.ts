// Peering state on disk under ~/.eos/peer/ — all 0600 (identity key, relay
// bearers). Small JSON lists rewritten atomically (tmp + rename) so a crash
// mid-write never leaves a torn trust list.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { ZodType } from "zod";

import { KnownHostSchema, OpenInviteSchema, PairedDeviceSchema, type KnownHost, type OpenInvite, type PairedDevice } from "../../../contracts/src/peer.ts";
import type { KnownHostStore, OpenInviteStore, PairedDeviceStore } from "../../../core/src/ports/PeerStore.ts";
import { createSelfSignedIdentity, certFingerprint, pemToDer, type PeerIdentityMaterial } from "./x509.ts";
import { safeStringify } from "../util/json.ts";

const SECRET_MODE = 0o600;

function writeSecret(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: SECRET_MODE });
  renameSync(tmp, path);
  chmodSync(path, SECRET_MODE);
}

// The device identity survives restarts and upgrades: losing it forces every
// paired computer to pair again, so it is minted once and never rotated here.
export function loadOrCreateIdentity(peerDir: string): PeerIdentityMaterial {
  const keyPath = join(peerDir, "device.key");
  const certPath = join(peerDir, "device.crt");
  if (existsSync(keyPath) && existsSync(certPath)) {
    const keyPem = readFileSync(keyPath, "utf8");
    const certPem = readFileSync(certPath, "utf8");
    return { keyPem, certPem, fingerprint: certFingerprint(pemToDer(certPem)) };
  }
  const id = createSelfSignedIdentity();
  writeSecret(keyPath, id.keyPem);
  writeSecret(certPath, id.certPem);
  return id;
}

// This Mac's peering room on a relay: a routing id and the owner secret that
// pins the room to this Mac (the relay stores only its hash). Kept apart from
// the iPhone's room so the two never evict each other's devices.
export function loadOrCreateRelayRoom(peerDir: string): { room: string; owner: string } {
  const path = join(peerDir, "relay-room.json");
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { room?: unknown; owner?: unknown };
    if (typeof parsed.room === "string" && typeof parsed.owner === "string") return { room: parsed.room, owner: parsed.owner };
  }
  const created = { room: randomBytes(32).toString("base64url"), owner: randomBytes(32).toString("base64url") };
  writeSecret(path, safeStringify(created) + "\n");
  return created;
}

class JsonListStore<T> {
  private readonly path: string;
  private readonly schema: ZodType<T>;
  private readonly keyOf: (item: T) => string;
  private items: Map<string, T> | null = null;

  constructor(path: string, schema: ZodType<T>, keyOf: (item: T) => string) {
    this.path = path;
    this.schema = schema;
    this.keyOf = keyOf;
  }

  private load(): Map<string, T> {
    if (this.items) return this.items;
    const map = new Map<string, T>();
    if (existsSync(this.path)) {
      const raw: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      // An entry that no longer parses is dropped rather than sinking the list.
      for (const entry of Array.isArray(raw) ? raw : []) {
        const parsed = this.schema.safeParse(entry);
        if (parsed.success) map.set(this.keyOf(parsed.data), parsed.data);
      }
    }
    this.items = map;
    return map;
  }

  private flush(): void {
    writeSecret(this.path, safeStringify([...this.load().values()]) + "\n");
  }

  list(): T[] { return [...this.load().values()]; }
  get(key: string): T | null { return this.load().get(key) ?? null; }
  upsert(item: T): void { this.load().set(this.keyOf(item), item); this.flush(); }
  remove(key: string): boolean {
    const removed = this.load().delete(key);
    if (removed) this.flush();
    return removed;
  }
}

export function createPairedDeviceStore(peerDir: string): PairedDeviceStore {
  return new JsonListStore<PairedDevice>(join(peerDir, "devices.json"), PairedDeviceSchema, (d) => d.fp);
}

export function createOpenInviteStore(peerDir: string): OpenInviteStore {
  return new JsonListStore<OpenInvite>(join(peerDir, "invites.json"), OpenInviteSchema, (i) => i.hash);
}

export function createKnownHostStore(peerDir: string): KnownHostStore {
  return new JsonListStore<KnownHost>(join(peerDir, "hosts.json"), KnownHostSchema, (h) => h.id);
}
