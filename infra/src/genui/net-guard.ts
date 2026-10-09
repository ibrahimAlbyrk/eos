// Which addresses the media fetcher may connect to. Everything that isn't a
// public unicast address is refused: loopback, private, link-local, CGNAT,
// multicast, documentation/benchmark ranges, IPv6 ULA/link-local/site-local,
// and the IPv4 embedded in mapped / compatible / NAT64 / 6to4 IPv6 forms.

import { isIP } from "node:net";

type V4Range = readonly [base: number, bits: number];

const V4_BLOCKED: readonly V4Range[] = [
  [v4("0.0.0.0"), 8], // "this network"
  [v4("10.0.0.0"), 8],
  [v4("100.64.0.0"), 10], // CGNAT
  [v4("127.0.0.0"), 8],
  [v4("169.254.0.0"), 16], // link-local (cloud metadata lives here)
  [v4("172.16.0.0"), 12],
  [v4("192.0.0.0"), 24],
  [v4("192.0.2.0"), 24],
  [v4("192.88.99.0"), 24],
  [v4("192.168.0.0"), 16],
  [v4("198.18.0.0"), 15],
  [v4("198.51.100.0"), 24],
  [v4("203.0.113.0"), 24],
  [v4("224.0.0.0"), 4], // multicast
  [v4("240.0.0.0"), 4], // reserved + broadcast
];

function v4(s: string): number {
  const parts = s.split(".").map(Number);
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

export function parseIPv4(s: string): number | null {
  if (isIP(s) !== 4) return null;
  return v4(s);
}

function v4Blocked(n: number): boolean {
  for (const [base, bits] of V4_BLOCKED) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((n & mask) >>> 0) === ((base & mask) >>> 0)) return true;
  }
  return false;
}

// 128-bit value of an IPv6 address (with or without brackets, zone id dropped).
export function parseIPv6(input: string): bigint | null {
  let s = input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input;
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (isIP(s) !== 6) return null;
  let tail: number[] = [];
  // An embedded dotted quad (::ffff:1.2.3.4) is the last 32 bits.
  const dot = s.lastIndexOf(":");
  if (s.slice(dot + 1).includes(".")) {
    const n = parseIPv4(s.slice(dot + 1));
    if (n == null) return null;
    tail = [n >>> 16, n & 0xffff];
    s = `${s.slice(0, dot + 1)}0:0`;
  }
  const [head, rest] = s.includes("::") ? s.split("::") : [s, null];
  const left = head ? head.split(":") : [];
  const right = rest ? rest.split(":") : [];
  const fill = rest === null ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array(fill).fill("0"), ...right].map((g) => parseInt(g || "0", 16));
  if (groups.length !== 8 || groups.some((g) => !Number.isFinite(g))) return null;
  if (tail.length) groups.splice(6, 2, ...tail);
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(g), 0n);
}

function prefix(value: bigint, bits: number): bigint {
  return value >> BigInt(128 - bits);
}

const V6 = (s: string): bigint => parseIPv6(s) as bigint;

// [base, prefix bits]; an entry with `embedded` re-checks the IPv4 inside.
const V6_RANGES: ReadonlyArray<{ base: bigint; bits: number; embedded?: (v: bigint) => number }> = [
  { base: V6("::ffff:0:0"), bits: 96, embedded: (v) => Number(v & 0xffffffffn) },
  { base: V6("::"), bits: 96, embedded: (v) => Number(v & 0xffffffffn) }, // IPv4-compatible, ::, ::1
  { base: V6("64:ff9b::"), bits: 96, embedded: (v) => Number(v & 0xffffffffn) }, // NAT64
  { base: V6("2002::"), bits: 16, embedded: (v) => Number((v >> 80n) & 0xffffffffn) }, // 6to4
  { base: V6("64:ff9b:1::"), bits: 48 },
  { base: V6("100::"), bits: 64 }, // discard
  { base: V6("2001::"), bits: 23 }, // IETF protocol assignments (Teredo, …)
  { base: V6("2001:db8::"), bits: 32 }, // documentation
  { base: V6("3fff::"), bits: 20 }, // documentation
  { base: V6("fc00::"), bits: 7 }, // unique local
  { base: V6("fe80::"), bits: 10 }, // link-local
  { base: V6("fec0::"), bits: 10 }, // site-local (deprecated)
  { base: V6("ff00::"), bits: 8 }, // multicast
];

function v6Blocked(v: bigint): boolean {
  for (const r of V6_RANGES) {
    if (prefix(v, r.bits) !== prefix(r.base, r.bits)) continue;
    if (!r.embedded) return true;
    // ::/96 holds :: and ::1 too — both land in 0.0.0.0/8.
    return v4Blocked(r.embedded(v) >>> 0);
  }
  return false;
}

// True for any address the fetcher must not reach. Unparseable input is refused.
export function isBlockedAddress(address: string): boolean {
  const n4 = parseIPv4(address);
  if (n4 != null) return v4Blocked(n4);
  const n6 = parseIPv6(address);
  if (n6 != null) return v6Blocked(n6);
  return true;
}
