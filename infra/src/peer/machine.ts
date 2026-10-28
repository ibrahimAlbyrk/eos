// Facts about this machine that peering shows to other devices.

import { hostname, networkInterfaces } from "node:os";
import { hostPlatform } from "../platform/index.ts";

// The name people gave this computer ("Office iMac"), not the DNS hostname.
export function computerName(): string {
  return hostPlatform.friendlyComputerName() ?? (hostname().replace(/\.local$/, "") || "Eos");
}

// Where a device on this network (or tailnet) can reach a port on this Mac:
// every non-internal IPv4 plus global IPv6. Link-local v6 is skipped — it needs
// a zone id a peer on another interface can't use.
export function directAddresses(port: number): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.internal) continue;
      if (a.family === "IPv4") out.push(`${a.address}:${port}`);
      else if (!a.address.toLowerCase().startsWith("fe80")) out.push(`[${a.address}]:${port}`);
    }
  }
  return out;
}

export function parseAddress(addr: string): { host: string; port: number } | null {
  const m = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(addr) ?? /^([^\s:[\]]+):(\d{1,5})$/.exec(addr);
  if (!m) return null;
  const port = Number(m[2]);
  return port > 0 && port < 65536 ? { host: m[1], port } : null;
}
