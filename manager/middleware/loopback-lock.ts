// Loopback-lock — the #1-ranked-threat mitigation (design §2.2, §4.1, §4.7).
//
// The remote edge is the authenticated /ws gateway ONLY. WS upgrades are handled
// on the server's "upgrade" event and never reach the normal request handler, so
// any request arriving HERE is a plain REST/SSE/raw call. If it came from a
// non-loopback peer, the daemon's bind was widened (e.g. host=0.0.0.0) and the
// whole REST surface — including the raw 7401 disk-bytes server — would be
// exposed off-box. We reject it: even with a public bind, the only thing
// reachable from off-box is the E2E-terminating WS upgrade.
//
// We trust ONLY the kernel-reported peer address (req.socket.remoteAddress),
// never a spoofable X-Forwarded-For — the daemon sits behind no reverse proxy.

import type { IncomingMessage } from "node:http";

const LOOPBACK_V4_PREFIX = "127.";

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false; // unknown peer → treat as untrusted
  // Normalize the IPv4-mapped IPv6 form (::ffff:127.0.0.1).
  const a = addr.startsWith("::ffff:") ? addr.slice("::ffff:".length) : addr;
  return a === "::1" || a.startsWith(LOOPBACK_V4_PREFIX);
}

export function isLoopbackRequest(req: IncomingMessage): boolean {
  return isLoopbackAddress(req.socket?.remoteAddress);
}
