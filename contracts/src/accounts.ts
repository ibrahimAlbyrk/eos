// Accounts (Settings › Accounts) — one per provider: an optional subscription
// sign-in plus an optional API key. Which of the two a provider's sessions bill is
// the BillingRoute (core/src/domain/billing-route.ts): signed in → the subscription,
// always; an expired sign-in → blocked (never a silent fallback to the metered key);
// otherwise the API key. Every shape here is REDACTED — no raw token or key ever
// leaves the daemon; `apiKey.hint` is at most the key's last four characters.

import { z } from "zod";

export const SubscriptionStateSchema = z.enum(["signed_out", "signed_in", "expired"]);
export type SubscriptionState = z.infer<typeof SubscriptionStateSchema>;

export const BillingRouteSchema = z.enum(["subscription", "api_key", "blocked", "none"]);
export type BillingRoute = z.infer<typeof BillingRouteSchema>;

export const AccountSubscriptionSchema = z.object({
  // false: the provider sells a plan but Eos has no lane that can run on it yet.
  supported: z.boolean(),
  state: SubscriptionStateSchema,
  // eos = signed in through Eos; claude-code = the Claude Code login on this
  // machine; codex = the Codex login on this machine (~/.codex, which Eos's own
  // ChatGPT sign-in also writes); gemini-cli = the Gemini CLI's Google login
  // (~/.gemini, which Eos's own Google sign-in also writes); env =
  // CLAUDE_CODE_OAUTH_TOKEN in the daemon's env.
  source: z.enum(["eos", "claude-code", "codex", "gemini-cli", "env"]).optional(),
  plan: z.string().optional(),
});
export type AccountSubscription = z.infer<typeof AccountSubscriptionSchema>;

export const AccountStatusSchema = z.object({
  // "anthropic" or a provider preset id (manager/shared/provider-presets.ts).
  id: z.string(),
  label: z.string(),
  // null: an API-key-only provider (it sells no subscription).
  subscription: AccountSubscriptionSchema.nullable(),
  apiKey: z.object({ set: z.boolean(), hint: z.string().optional() }),
  route: BillingRouteSchema,
  // The config.backends profile the provider's API key is stored on (presets only).
  profile: z.string().optional(),
});
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

export const AccountsResponseSchema = z.object({ accounts: z.array(AccountStatusSchema) });
export type AccountsResponse = z.infer<typeof AccountsResponseSchema>;

// A browser sign-in in flight. `url` is the provider's sign-in page (the UI's
// "Copy link" when the browser didn't open); `error` is set on failed.
export const SignInStateSchema = z.enum(["starting", "waiting", "succeeded", "failed", "cancelled"]);
export type SignInState = z.infer<typeof SignInStateSchema>;

export const SignInSessionSchema = z.object({
  id: z.string(),
  provider: z.string(),
  state: SignInStateSchema,
  url: z.string().optional(),
  // The provider's page may show a code to paste back (its redirect can't reach
  // this machine) — the UI offers a code field only when this is true.
  codeEntry: z.boolean().optional(),
  error: z.string().optional(),
});
export type SignInSession = z.infer<typeof SignInSessionSchema>;

// The code the provider's page shows when its redirect can't reach this machine.
export const SignInCodeRequestSchema = z.object({ code: z.string().trim().min(1).max(4096) }).strict();
export type SignInCodeRequest = z.infer<typeof SignInCodeRequestSchema>;
