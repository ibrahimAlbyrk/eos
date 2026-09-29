// AccountsService — the read side of Settings › Accounts: one redacted
// AccountStatus per provider. Claude comes first, followed by every provider
// preset, whose API key lives in the Keychain behind a config.backends profile.
// Only sign-ins made through Eos count — a Claude Code, Codex or Gemini CLI login
// elsewhere on this Mac is ignored, since Eos neither bills nor reads usage from
// it. The route each account bills is the Accounts rule (core/domain/billing-route)
// — never recomputed here.
//
// A legacy Eos setup-token is checked against the API (cached) so a revoked or
// expired token shows as "expired" and blocks, rather than failing inside a session.

import type { AccountStatus, AccountSubscription } from "../../../contracts/src/accounts.ts";
import type { BackendProfile } from "../../../contracts/src/backend.ts";
import type { ClaudeCodeLogin } from "../../../infra/src/auth/SubscriptionAuthResolver.ts";
import type { TokenProbeResult } from "../../../infra/src/auth/claudeTokenProbe.ts";
import type { ProviderPreset } from "../../shared/provider-presets.ts";
import { resolveBillingRoute } from "../../../core/src/domain/billing-route.ts";

// Providers that sell a subscription; the rest are API-key-only. Whether Eos can
// run on it yet is `supportsSignIn` — a separate question.
const SUBSCRIPTION_PRODUCTS = new Set(["anthropic", "openai", "gemini"]);

const PROBE_TTL_MS = 10 * 60_000;

export interface AccountsServiceDeps {
  getConfig(): { anthropic: { apiKey?: string; authToken?: string }; backends: Record<string, BackendProfile> };
  /** The Claude login in Eos's own credential store. */
  readClaudeLogin(): ClaudeCodeLogin;
  probe(token: string): Promise<TokenProbeResult>;
  presets: readonly ProviderPreset[];
  supportsSignIn(provider: string): boolean;
  /** A preset provider's plan sign-in, when it has one Eos can read (openai →
   *  the Codex login). null = no plan login to look for. */
  presetLogin?(provider: string): { present: boolean; plan?: string; source: NonNullable<AccountSubscription["source"]> } | null;
  now?(): number;
}

export class AccountsService {
  private readonly deps: AccountsServiceDeps;
  private probed: { token: string; result: TokenProbeResult; at: number } | null = null;

  constructor(deps: AccountsServiceDeps) {
    this.deps = deps;
  }

  /** A credential changed — drop the cached probe so the next list re-checks. */
  invalidate(): void {
    this.probed = null;
  }

  async list(): Promise<AccountStatus[]> {
    return [await this.claude(), ...this.deps.presets.map((p) => this.preset(p))];
  }

  private async claude(): Promise<AccountStatus> {
    const { anthropic } = this.deps.getConfig();
    const token = anthropic.authToken?.trim();
    const apiKey = anthropic.apiKey?.trim();
    const supported = this.deps.supportsSignIn("anthropic");

    let subscription: AccountSubscription;
    const login = this.deps.readClaudeLogin();
    if (login.present) {
      subscription = { supported, state: "signed_in", source: "eos", ...(login.plan ? { plan: login.plan } : {}) };
    } else if (token) {
      const probe = await this.probeCached(token);
      subscription = { supported, state: probe === "rejected" ? "expired" : "signed_in", source: "eos" };
    } else {
      subscription = { supported, state: "signed_out" };
    }

    return {
      id: "anthropic",
      label: "Claude",
      subscription,
      apiKey: { set: Boolean(apiKey), ...(apiKey ? { hint: apiKey.slice(-4) } : {}) },
      route: resolveBillingRoute(subscription.state, Boolean(apiKey)),
    };
  }

  private preset(p: ProviderPreset): AccountStatus {
    const profile = Object.entries(this.deps.getConfig().backends)
      .find(([, b]) => b.auth?.kind === "keychain" && b.auth.ref === p.authRef)?.[0];
    let subscription: AccountSubscription | null = null;
    if (SUBSCRIPTION_PRODUCTS.has(p.id)) {
      const supported = this.deps.supportsSignIn(p.id);
      const login = this.deps.presetLogin?.(p.id) ?? null;
      // A plan Eos has no lane for can't bill anything — the key keeps the route.
      subscription = login?.present && supported
        ? { supported, state: "signed_in", source: login.source, ...(login.plan ? { plan: login.plan } : {}) }
        : { supported, state: "signed_out" };
    }
    return {
      id: p.id,
      label: p.label,
      subscription,
      apiKey: { set: Boolean(profile) },
      route: resolveBillingRoute(subscription?.state ?? "signed_out", Boolean(profile)),
      ...(profile ? { profile } : {}),
    };
  }

  private async probeCached(token: string): Promise<TokenProbeResult> {
    const now = this.deps.now?.() ?? Date.now();
    if (this.probed && this.probed.token === token && now - this.probed.at < PROBE_TTL_MS) return this.probed.result;
    const result = await this.deps.probe(token);
    // "unknown" (offline, 5xx) is not cached — the next open re-checks.
    this.probed = result === "unknown" ? null : { token, result, at: now };
    return result;
  }
}
