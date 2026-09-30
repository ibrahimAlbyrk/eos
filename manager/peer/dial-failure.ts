// Why a route to another Mac failed, in words a person can act on. The errno is
// what separates "macOS keeps Eos off the local network" from "nothing listens
// there" and "the relay is out of reach from this network" — and each asks the
// person to do something different.

import type { LinkRoute } from "../../contracts/src/peer.ts";

export interface DialFailure {
  route: LinkRoute;
  code: string;
}

export function dialFailure(route: LinkRoute, e: unknown): DialFailure {
  const code = (e as { code?: unknown } | null)?.code;
  return { route, code: typeof code === "string" ? code : "UNKNOWN" };
}

// macOS Local Network privacy fails a LAN connect at once with "no route to host".
const NO_LAN_ROUTE = new Set(["EHOSTUNREACH", "ENETUNREACH"]);

export function blockedFromLocalNetwork(failures: readonly DialFailure[]): boolean {
  return failures.some((f) => f.route === "direct" && NO_LAN_ROUTE.has(f.code));
}

function explain(f: DialFailure): { rank: number; text: string } {
  if (f.route === "relay") {
    return f.code === "ROOM_NOT_FOUND"
      ? { rank: 3, text: "it isn't on its relay right now" }
      : { rank: 3, text: "its relay can't be reached from this network" };
  }
  if (f.route === "reverse") return { rank: 4, text: "its own link to this Mac dropped" };
  if (NO_LAN_ROUTE.has(f.code)) {
    return { rank: 0, text: "macOS may be keeping Eos off the local network — allow Eos in System Settings › Privacy & Security › Local Network" };
  }
  if (f.code === "ECONNREFUSED") return { rank: 1, text: "nothing answered at its address — is Eos running there with Direct on?" };
  if (f.code === "EHOSTDOWN") return { rank: 2, text: "it isn't on this network" };
  return { rank: 2, text: "its address didn't answer — a firewall on that Mac, or you're on different networks" };
}

// Each distinct cause once, the one most worth acting on first.
export function explainDialFailures(failures: readonly DialFailure[]): string {
  const reasons = failures.map(explain).sort((a, b) => a.rank - b.rank).map((r) => r.text);
  return [...new Set(reasons)].join("; ");
}
