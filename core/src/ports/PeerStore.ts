import type { KnownHost, PairedDevice } from "../../../contracts/src/peer.ts";

// Devices allowed to control this Mac (host side of peering).
export interface PairedDeviceStore {
  list(): PairedDevice[];
  get(fp: string): PairedDevice | null;
  upsert(device: PairedDevice): void;
  remove(fp: string): boolean;
}

// Hosts this Mac controls (device side of peering). Holds relay bearers.
export interface KnownHostStore {
  list(): KnownHost[];
  get(id: string): KnownHost | null;
  upsert(host: KnownHost): void;
  remove(id: string): boolean;
}
