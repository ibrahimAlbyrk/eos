import { randomBytes } from "node:crypto";
import { bearerAllowed, constantTimeHexEqual, ownerHashMatches, sha256Hex } from "./admission.ts";
import { RelayError, type RelayErrorCode } from "./errors.ts";
import { CLIENT_ID_LEN } from "./envelope.ts";

// In-memory room registry — protocol §5. No keys, no content is persisted; the
// relay forwards opaque application-byte payloads verbatim and is protocol-
// version-independent (blind to whether they are plaintext or encrypted).

export type RelaySocket = { send(data: Buffer): void; close(): void };

type Room = {
  ownerHash: string; // SHA-256(owner bearer), hex — pinned via TOFU or operator env
  mac: RelaySocket | null;
  allow: Set<string>; // device-bearer SHA-256 hashes, hex
  devices: Map<string, RelaySocket>; // clientId(hex) -> device socket
};

type ConnMeta =
  | { role: "mac"; room: string }
  | { role: "device"; room: string; clientId: string };

// What the server must announce after a socket drop: a device leaving is told to
// its room's Mac so the daemon disposes that session at once instead of waiting
// out its idle TTL.
export type DropResult =
  | { role: "device"; room: string; clientId: Buffer; mac: RelaySocket | null }
  | { role: "mac"; room: string }
  | null;

type Ok<T> = { ok: true } & T;
type Err = { ok: false; code: RelayErrorCode };

export class RoomRegistry {
  private rooms = new Map<string, Room>();
  private meta = new Map<RelaySocket, ConnMeta>();
  private ownerHashPin: string | null;
  private maxRoomDevices: number;
  // The owner hash a room kept from an earlier run of the relay, so a restart does not reopen
  // the room to whoever registers first.
  private knownOwner: (room: string) => string | null;

  constructor(opts: { ownerHashPin?: string | null; maxRoomDevices?: number; knownOwner?: (room: string) => string | null } = {}) {
    this.ownerHashPin = opts.ownerHashPin ?? null;
    this.maxRoomDevices = opts.maxRoomDevices ?? 32;
    this.knownOwner = opts.knownOwner ?? (() => null);
  }

  // Mac claims/owns a room (§5.2). First valid registration pins the owner hash
  // (TOFU) unless an operator pre-pin is configured; re-register replaces the Mac
  // socket (Mac reconnect) and refreshes the allowlist. Devices joined through a
  // different, still-open Mac socket belong to a daemon session that no longer
  // exists — close them so they re-join (and resync) against the new one.
  register(room: string, ownerBearer: string, allow: string[], socket: RelaySocket): Ok<{ replaced: boolean }> | Err {
    const existing = this.rooms.get(room);
    if (existing) {
      if (!ownerHashMatches(ownerBearer, existing.ownerHash)) return { ok: false, code: RelayError.OWNER_MISMATCH };
      if (existing.mac && existing.mac !== socket) this.evictDevices(existing);
      existing.mac = socket;
      existing.allow = new Set(allow.map((h) => h.toLowerCase()));
      this.meta.set(socket, { role: "mac", room });
      return { ok: true, replaced: true };
    }
    const ownerHash = sha256Hex(ownerBearer);
    if (this.ownerHashPin && this.ownerHashPin !== ownerHash) return { ok: false, code: RelayError.OWNER_MISMATCH };
    const known = this.knownOwner(room);
    if (known && !constantTimeHexEqual(ownerHash, known)) return { ok: false, code: RelayError.OWNER_MISMATCH };
    this.rooms.set(room, {
      ownerHash,
      mac: socket,
      allow: new Set(allow.map((h) => h.toLowerCase())),
      devices: new Map(),
    });
    this.meta.set(socket, { role: "mac", room });
    return { ok: true, replaced: false };
  }

  // Device admission (§5.3). Constant-time bearer-hash membership; on success assign
  // a 16-byte clientId and return the Mac socket so the caller can notify it.
  join(room: string, bearer: string, socket: RelaySocket): Ok<{ clientId: Buffer; mac: RelaySocket }> | Err {
    const r = this.rooms.get(room);
    if (!r || !r.mac) return { ok: false, code: RelayError.ROOM_NOT_FOUND };
    if (!bearerAllowed(bearer, r.allow)) return { ok: false, code: RelayError.BEARER_DENIED };
    if (r.devices.size >= this.maxRoomDevices) return { ok: false, code: RelayError.ROOM_FULL };
    const clientId = randomBytes(CLIENT_ID_LEN);
    const hex = clientId.toString("hex");
    r.devices.set(hex, socket);
    this.meta.set(socket, { role: "device", room, clientId: hex });
    return { ok: true, clientId, mac: r.mac };
  }

  // Mac-only allowlist mutation (§5.2 relayctl allow-add/allow-remove).
  updateAllow(room: string, op: "add" | "remove", hash: string, fromSocket: RelaySocket): Ok<{}> | Err {
    const r = this.rooms.get(room);
    if (!r || !this.ownsRoom(room, fromSocket)) return { ok: false, code: RelayError.OWNER_MISMATCH };
    if (op === "add") r.allow.add(hash.toLowerCase());
    else r.allow.delete(hash.toLowerCase());
    return { ok: true };
  }

  // Forward an opaque data frame verbatim (§4.3). c2s -> Mac, s2c -> devices[clientId].
  routeData(room: string, dir: number, clientIdHex: string, rawFrame: Buffer): Ok<{}> | Err {
    const r = this.rooms.get(room);
    if (!r) return { ok: false, code: RelayError.ROOM_NOT_FOUND };
    const target = dir === 0x00 ? r.mac : r.devices.get(clientIdHex);
    if (!target) return { ok: false, code: RelayError.ROOM_NOT_FOUND };
    target.send(rawFrame);
    return { ok: true };
  }

  // Whether the socket is the room's current Mac: only it may change the allowlist or push.
  ownsRoom(room: string, socket: RelaySocket): boolean {
    const m = this.meta.get(socket);
    return Boolean(m && m.role === "mac" && m.room === room && this.rooms.get(room)?.mac === socket);
  }

  // Connection teardown. A dropped Mac leaves the room (and its allowlist) intact for
  // reconnect but closes its devices (their daemon session died with it); a dropped
  // device is removed from routing and reported so the server can tell the Mac.
  drop(socket: RelaySocket): DropResult {
    const m = this.meta.get(socket);
    if (!m) return null;
    this.meta.delete(socket);
    const r = this.rooms.get(m.room);
    if (!r) return null;
    if (m.role === "mac") {
      if (r.mac !== socket) return null;
      r.mac = null;
      this.evictDevices(r);
      return { role: "mac", room: m.room };
    }
    if (r.devices.get(m.clientId) !== socket) return null;
    r.devices.delete(m.clientId);
    return { role: "device", room: m.room, clientId: Buffer.from(m.clientId, "hex"), mac: r.mac };
  }

  // Meta goes first so the resulting close → drop is a no-op: no "left" is sent
  // for a device the (new) Mac never knew.
  private evictDevices(r: Room): void {
    for (const socket of r.devices.values()) {
      this.meta.delete(socket);
      try { socket.close(); } catch { /* already closing */ }
    }
    r.devices.clear();
  }

  roomCount(): number {
    return this.rooms.size;
  }
}
