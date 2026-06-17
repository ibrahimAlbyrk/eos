// Backend billing intent — the guard that keeps a metered API from silently
// charging when the user expected subscription billing. Subscription-billed kinds
// (the Max/Pro plan pays) are exempt; every other kind is a per-token metered API
// that must be explicitly opted into via a profile's costMode:"billed".

import type { ResolvedBackend } from "../ports/BackendDefaults.ts";

// claude-cli (PTY) and claude-sdk both draw on the user's Claude subscription.
const SUBSCRIPTION_KINDS = new Set(["claude-cli", "claude-sdk"]);

export function isMeteredBackend(rb: ResolvedBackend): boolean {
  return !SUBSCRIPTION_KINDS.has(rb.kind);
}

// True when a metered-API backend was selected without the explicit costMode:"billed"
// opt-in — the caller should reject it rather than bill the metered API by surprise.
export function meteredNeedsBilledIntent(rb: ResolvedBackend): boolean {
  return isMeteredBackend(rb) && rb.costMode !== "billed";
}
