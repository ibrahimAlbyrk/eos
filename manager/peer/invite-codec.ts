// `eos://pair/<base64url(JSON)>` — the out-of-band invite a person copies from
// the host's Settings into the device's "Connect a machine" sheet.

import { PEER_INVITE_PREFIX, PeerInviteSchema, type PeerInvite } from "../../contracts/src/peer.ts";
import { safeStringify } from "../../infra/src/util/json.ts";

export function encodeInvite(invite: PeerInvite): string {
  return PEER_INVITE_PREFIX + Buffer.from(safeStringify(invite), "utf8").toString("base64url");
}

export class InviteFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InviteFormatError";
  }
}

export function decodeInvite(link: string): PeerInvite {
  const trimmed = link.trim();
  if (!trimmed.startsWith(PEER_INVITE_PREFIX)) throw new InviteFormatError("not an Eos invite link");
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(trimmed.slice(PEER_INVITE_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw new InviteFormatError("invite link is damaged — copy it again");
  }
  const parsed = PeerInviteSchema.safeParse(json);
  if (!parsed.success) throw new InviteFormatError("invite link is from an incompatible Eos version");
  return parsed.data;
}
