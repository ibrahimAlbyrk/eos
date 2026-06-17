// Env vars that must NEVER reach a subscription-billed child (the claude-cli PTY
// worker or the claude-sdk OAuth child): their mere presence silently diverts
// billing off the user's Max/Pro subscription — an API key / auth token onto a
// metered API pool, a base URL onto a proxy that disables subscription auth.
// Stripped at every site that spreads the daemon's process.env into such a child.

export const SUBSCRIPTION_ENV_DENYLIST: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
];

// A copy of `env` with the subscription-diverting vars removed. Used by the SDK
// billing-env builder and composed into buildSubscriptionChildEnv (the PTY child).
export function scrubSubscriptionEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (SUBSCRIPTION_ENV_DENYLIST.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

// The env for a claude-cli PTY child: subscription-scrubbed, AND with the parent
// Claude Code session markers (CLAUDECODE / CLAUDE_CODE_*) removed so each worker
// boots as its own top-level interactive session — the daemon is often launched
// from inside a Claude Code session, so those would otherwise leak in and nest it
// (a nested session renders no assistant text → blank chat).
export function buildSubscriptionChildEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
    if (SUBSCRIPTION_ENV_DENYLIST.includes(k)) continue;
    out[k] = v;
  }
  return out;
}
