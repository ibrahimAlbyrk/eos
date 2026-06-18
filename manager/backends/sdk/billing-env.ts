// Env for the SDK-spawned `claude` child (the claude-sdk backend drives the
// bundled claude binary as a subprocess; that child resolves billing auth from
// the env it receives). buildSubscriptionChildEnv strips the silent billing
// winners (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL) so they
// can't shadow the OAuth token, AND the parent CLAUDECODE / CLAUDE_CODE_* session
// markers — the SDK passes options.env through to the child verbatim, so leaking
// those makes it boot as a NESTED session (blank chat), the same failure the PTY
// lane guards against. Then inject the OAuth token (after the strip, so it wins),
// force direct tool loading (ENABLE_TOOL_SEARCH=false), and carry the EOS_* triplet.

import type { ResolvedAuth } from "../../../core/src/ports/AuthResolver.ts";
import { buildSubscriptionChildEnv } from "../../../core/src/domain/env-allowlist.ts";

export interface BillingGuardInput {
  readonly auth: ResolvedAuth;
  readonly workerId: string;
  readonly daemonUrl: string;
}

export function buildBillingGuardEnv(input: BillingGuardInput): Record<string, string> {
  return {
    ...buildSubscriptionChildEnv(process.env),
    ...(input.auth.scheme === "oauth" && input.auth.token ? { CLAUDE_CODE_OAUTH_TOKEN: input.auth.token } : {}),
    ENABLE_TOOL_SEARCH: "false",
    EOS_SPAWNED: "1",
    EOS_WORKER_ID: input.workerId,
    EOS_DAEMON_URL: input.daemonUrl,
  };
}
