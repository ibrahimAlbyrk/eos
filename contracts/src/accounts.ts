// Accounts (Settings › Accounts) — one per provider: optional subscription
// sign-ins plus an optional API key. Which of the two a provider's sessions bill is
// the BillingRoute (core/src/domain/billing-route.ts): signed in → the subscription,
// always; an expired sign-in → blocked (never a silent fallback to the metered key);
// otherwise the API key. A provider whose plan holds several sign-ins (Claude) lists
// them as `logins`; new sessions start on the default one. Every shape here is
// REDACTED — no raw token, key or credential store path ever leaves the daemon;
// `apiKey.hint` is at most the key's last four characters.

import { z } from "zod";

export const SubscriptionStateSchema = z.enum(["signed_out", "signed_in", "expired"]);
export type SubscriptionState = z.infer<typeof SubscriptionStateSchema>;

export const BillingRouteSchema = z.enum(["subscription", "api_key", "blocked", "none"]);
export type BillingRoute = z.infer<typeof BillingRouteSchema>;

export const AccountSubscriptionSchema = z.object({
  // false: the provider sells a plan but Eos has no lane that can run on it yet.
  supported: z.boolean(),
  state: SubscriptionStateSchema,
  // eos = signed in through Eos — the only sign-in Eos counts; a CLI login
  // elsewhere on this Mac is ignored.
  source: z.enum(["eos"]).optional(),
  plan: z.string().optional(),
});
export type AccountSubscription = z.infer<typeof AccountSubscriptionSchema>;

// One plan sign-in of a provider that holds several, each in its own credential
// store. `state` is read live from that store.
export const PlanLoginSchema = z.object({
  id: z.string(),
  label: z.string(),
  email: z.string().optional(),
  plan: z.string().optional(),
  state: SubscriptionStateSchema,
  // Hit its plan limit; new sessions skip it until then (ISO).
  limitedUntil: z.string().optional(),
  // Live sessions running on it right now (omitted when none).
  inUse: z.number().int().positive().optional(),
});
export type PlanLogin = z.infer<typeof PlanLoginSchema>;

export const AccountStatusSchema = z.object({
  // "anthropic" or a provider preset id (manager/shared/provider-presets.ts).
  id: z.string(),
  label: z.string(),
  // null: an API-key-only provider (it sells no subscription). For a provider with
  // `logins`, the sign-in new sessions run on (its plan and state).
  subscription: AccountSubscriptionSchema.nullable(),
  apiKey: z.object({ set: z.boolean(), hint: z.string().optional() }),
  route: BillingRouteSchema,
  // The config.backends profile the provider's API key is stored on (presets only).
  profile: z.string().optional(),
  // Set only for a provider that holds several sign-ins: all of them in the order
  // they were added (possibly none yet), and the one new sessions start on.
  logins: z.array(PlanLoginSchema).optional(),
  defaultLoginId: z.string().optional(),
  // Move a session to another sign-in when its own runs out mid-turn.
  autoSwitch: z.boolean().optional(),
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
  // The sign-in being renewed; absent when the sign-in adds a new one.
  loginId: z.string().optional(),
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

const LoginIdSchema = z.string().min(1).max(64);

// Starting a sign-in: `loginId` signs that sign-in in again; without it the
// sign-in adds one (a provider with a single sign-in ignores it).
export const SignInStartRequestSchema = z.object({ loginId: LoginIdSchema.optional() }).strict();
export type SignInStartRequest = z.infer<typeof SignInStartRequestSchema>;

export const PlanLoginRenameRequestSchema = z.object({ label: z.string().trim().min(1).max(60) }).strict();
export type PlanLoginRenameRequest = z.infer<typeof PlanLoginRenameRequestSchema>;

export const DefaultLoginRequestSchema = z.object({ loginId: LoginIdSchema }).strict();
export type DefaultLoginRequest = z.infer<typeof DefaultLoginRequestSchema>;

export const AutoSwitchRequestSchema = z.object({ enabled: z.boolean() }).strict();
export type AutoSwitchRequest = z.infer<typeof AutoSwitchRequestSchema>;

// An accounts_exhausted row's "Resume at": on schedules it, off cancels it.
export const PlanResumeRequestSchema = z.object({ rowId: z.number().int().positive(), on: z.boolean() }).strict();
export type PlanResumeRequest = z.infer<typeof PlanResumeRequestSchema>;
