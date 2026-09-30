// One pairing, both directions: redeem another computer's invite and — when the
// person asks — let that computer control this Mac too. The offer rides the
// same pairing; this Mac allows the other one only after it accepts.

import type { HostView } from "../../contracts/src/peer.ts";
import type { HostLinkService } from "./HostLinkService.ts";
import type { PeerHostService } from "./PeerHostService.ts";

export async function pairWith(
  peerHost: PeerHostService,
  hostLinks: HostLinkService,
  invite: string,
  opts: { alias?: string; mutual?: boolean },
): Promise<HostView & { mutual: boolean }> {
  const offer = opts.mutual ? peerHost.reciprocalOffer() : null;
  let mutual = false;
  const view = await hostLinks.pair(invite, opts.alias, offer ? {
    addrs: offer.addrs,
    relay: offer.relay,
    accepted: (host) => {
      mutual = true;
      peerHost.allowDevice({ fp: host.id, name: host.name, platform: host.platform, relayBearerHash: offer.relayBearerHash });
    },
  } : undefined);
  return { ...view, mutual };
}
