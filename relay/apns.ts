// Opt-in APNs egress — design §5.5 / §7.4, protocol §5.3 (apnsToken in join).
//
// Background push is OFF by default and fully self-hostable with zero push
// infrastructure. The relay only does APNs work when the operator supplies their
// OWN APNs key + bundle-id. With nothing configured this is a pure no-op: the relay
// requires no Apple credentials and nothing depends on it.
//
// pushIntent framing is PROVISIONAL (relayctl{pushIntent}); the content-free intent
// is `{reason, workerId, title, body, deeplink}` (design §5.5) and carries no real
// content — the title/body come from a closed reason→title table on the device side.

export type PushIntent = {
  reason?: string;
  workerId?: string;
  title?: string;
  body?: string;
  deeplink?: string;
};

export function apnsConfigured(): boolean {
  return Boolean(process.env.APNS_KEY && process.env.APNS_KEY_ID && process.env.APNS_BUNDLE_ID);
}

// No-op in v1: push is opt-in and dormant by default. Returns whether an APNs send
// was attempted (always false until the egress path is wired in a later phase).
export function sendPushIntent(_apnsToken: string | undefined, _intent: PushIntent): boolean {
  if (!apnsConfigured()) return false;
  // Egress to Apple is intentionally unimplemented in v1 — the path is built but
  // dormant. Wiring it requires the user's APNs auth key + bundle-id (design §10).
  return false;
}
