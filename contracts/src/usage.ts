// Provider-agnostic subscription usage snapshot — the read model behind the
// Settings > Usage pane. Claude is the only provider today; the shape is
// deliberately provider-neutral (a `provider` tag + an array response) so a
// future non-Claude subscription plugs in as another SubscriptionUsageProvider
// without a schema change. A provider that can't fetch is simply ABSENT from
// `providers` and surfaced in `errors` instead — one provider's outage never
// fails the whole pane.

import { z } from "zod";

// One rate-limit window. `utilization` is NORMALIZED to 0–100 (percent used) by
// the adapter — the upstream Claude endpoint already reports 0–100 (verified
// empirically), so the adapter clamps rather than rescales. `resetsAt` is an ISO
// timestamp for when the window rolls over.
export const UsageWindowSchema = z.object({
  utilization: z.number(),
  resetsAt: z.string(),
});
export type UsageWindow = z.infer<typeof UsageWindowSchema>;

// A window slot is present, explicitly null (provider reports "no data"), or
// omitted. The UI renders a row only when the window is present.
const WindowSlotSchema = UsageWindowSchema.nullable().optional();

export const ProviderUsageSchema = z.object({
  provider: z.string(), // "claude"
  plan: z.string().optional(), // e.g. "Max" — omitted when unknown
  windows: z.object({
    fiveHour: WindowSlotSchema, // rolling 5-hour session limit
    sevenDay: WindowSlotSchema, // weekly "all models" limit
    sevenDayOpus: WindowSlotSchema, // per-model weekly limits (only when scoped)
    sevenDaySonnet: WindowSlotSchema,
  }),
  extraUsage: z
    .object({
      isEnabled: z.boolean(),
      usedCredits: z.number().nullable().optional(),
      monthlyLimit: z.number().nullable().optional(),
    })
    .optional(),
  fetchedAt: z.string(), // ISO — when this snapshot was pulled upstream
});
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;

export const UsageErrorSchema = z.object({
  provider: z.string(),
  reason: z.string(),
});
export type UsageError = z.infer<typeof UsageErrorSchema>;

export const UsageResponseSchema = z.object({
  providers: z.array(ProviderUsageSchema),
  errors: z.array(UsageErrorSchema).optional(),
});
export type UsageResponse = z.infer<typeof UsageResponseSchema>;
