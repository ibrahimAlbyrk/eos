// Backend billing intent — the guard that keeps a metered API from silently
// charging when the user expected subscription billing. A backend's billing class
// is data (BackendDescriptor.billing), not a kind literal: subscription-billed
// providers (the Max/Pro plan pays) are exempt; metered providers are per-token
// APIs that must be explicitly opted into via a profile's costMode:"billed".

import type { ResolvedBackend } from "../ports/BackendDefaults.ts";
import type { BackendDescriptor } from "../ports/AgentBackend.ts";

export function isMeteredBackend(d: BackendDescriptor): boolean {
  return d.billing === "metered";
}

// True when a metered-API backend was selected without the explicit costMode:"billed"
// opt-in — the caller should reject it rather than bill the metered API by surprise.
export function meteredNeedsBilledIntent(d: BackendDescriptor, rb: ResolvedBackend): boolean {
  return isMeteredBackend(d) && rb.costMode !== "billed";
}
