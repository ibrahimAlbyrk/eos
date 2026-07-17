// Port: a single subscription provider's usage snapshot source. The Claude
// Max/Pro plan is the only implementation today (infra/usage/ClaudeUsageProvider);
// a future non-Claude subscription implements this same interface and drops into
// the UsageService provider list — that array IS the extension point.
//
// fetchUsage THROWS on failure (missing token, upstream error, insufficient
// scope). The UsageService catches and surfaces the reason in the response's
// errors[] so one provider's outage never fails the whole pane.

import type { ProviderUsage } from "../../../contracts/src/usage.ts";

export interface SubscriptionUsageProvider {
  /** Stable provider id, echoed into ProviderUsage.provider + any error entry. */
  readonly id: string;
  fetchUsage(): Promise<ProviderUsage>;
}
