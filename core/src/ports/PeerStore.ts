import type { KnownHost, OpenInvite, PairedDevice } from "../../../contracts/src/peer.ts";

// Devices allowed to control this Mac (host side of peering).
export interface PairedDeviceStore {
  list(): PairedDevice[];
  get(fp: string): PairedDevice | null;
  upsert(device: PairedDevice): void;
  remove(fp: string): boolean;
}

// Invite links made on this Mac and not yet used or cancelled (hashes only).
export interface OpenInviteStore {
  list(): OpenInvite[];
  upsert(invite: OpenInvite): void;
  remove(hash: string): boolean;
}

// Hosts this Mac controls (device side of peering). Holds relay bearers.
export interface KnownHostStore {
  list(): KnownHost[];
  get(id: string): KnownHost | null;
  upsert(host: KnownHost): void;
  remove(id: string): boolean;
}
