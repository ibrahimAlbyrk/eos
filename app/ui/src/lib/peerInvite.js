// Client-side reading of an `eos://pair/…` invite, so the Connect sheet can show
// WHICH computer a pasted link points at before anything is sent. The daemon
// re-validates everything; this is only for the preview.

const PREFIX = "eos://pair/";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// Mirrors core/src/domain/peer.ts formatDeviceId: 80 bits of the certificate
// fingerprint, Crockford base32, grouped by four.
export function formatDeviceId(fingerprintHex) {
  const bytes = [];
  for (let i = 0; i + 1 < Math.min(fingerprintHex.length, 20); i += 2) bytes.push(parseInt(fingerprintHex.slice(i, i + 2), 16));
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)?.join("-") ?? out;
}

// → { name, deviceId, fp, exp, direct, relay } | { error }
export function readInvite(link, now = Date.now()) {
  const text = (link ?? "").trim();
  if (!text) return null;
  if (!text.startsWith(PREFIX)) return { error: "That isn't an Eos invite link." };
  let invite;
  try {
    const b64 = text.slice(PREFIX.length).replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    invite = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { error: "The link is damaged — copy it again." };
  }
  if (invite?.v !== 1 || !/^[0-9a-f]{64}$/.test(invite.fp ?? "")) return { error: "This invite is from an incompatible Eos version." };
  if (now >= invite.exp * 1000) return { error: "This invite has expired — make a new one on that Mac." };
  return {
    name: String(invite.name ?? "Mac"),
    fp: invite.fp,
    deviceId: formatDeviceId(invite.fp),
    exp: invite.exp,
    direct: Array.isArray(invite.addrs) && invite.addrs.length > 0,
    relay: Boolean(invite.relay),
  };
}
