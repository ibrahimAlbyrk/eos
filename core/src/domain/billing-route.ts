// The Accounts rule — which credential a provider's sessions bill, in one place.
// Signed in ⇒ the subscription, always: the API key is never used alongside it.
// An EXPIRED sign-in blocks instead of quietly falling back to the metered key —
// the user expected their plan to pay, so they re-sign-in or sign out on purpose.
// Signed out ⇒ the API key, when one is set.

import type { BillingRoute, SubscriptionState } from "../../../contracts/src/accounts.ts";

export function resolveBillingRoute(subscription: SubscriptionState, apiKeySet: boolean): BillingRoute {
  if (subscription === "signed_in") return "subscription";
  if (subscription === "expired") return "blocked";
  return apiKeySet ? "api_key" : "none";
}
