// Env for the SDK-spawned `claude` child (the claude-sdk backend drives the
// bundled claude binary as a subprocess; that child resolves billing auth from
// the env it receives). The guard: strip the silent winners
// (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL) so they can't
// shadow the OAuth token, inject the subscription OAuth token, force direct
// (non-deferred) tool loading (ENABLE_TOOL_SEARCH=false), and carry the
// daemon-aware EOS_* triplet. (Whether the SDK replaces or overlays the child env
// is confirmed in the spike; either way, scrubbing the parent guarantees no key
// reaches the child.)

import type { ResolvedAuth } from "../../../core/src/ports/AuthResolver.ts";
import { scrubSubscriptionEnv } from "../../../core/src/domain/env-allowlist.ts";

export interface BillingGuardInput {
  readonly auth: ResolvedAuth;
  readonly workerId: string;
  readonly daemonUrl: string;
}

export function buildBillingGuardEnv(input: BillingGuardInput): Record<string, string> {
  return {
    ...scrubSubscriptionEnv(process.env),
    ...(input.auth.scheme === "oauth" && input.auth.token ? { CLAUDE_CODE_OAUTH_TOKEN: input.auth.token } : {}),
    ENABLE_TOOL_SEARCH: "false",
    EOS_SPAWNED: "1",
    EOS_WORKER_ID: input.workerId,
    EOS_DAEMON_URL: input.daemonUrl,
  };
}
