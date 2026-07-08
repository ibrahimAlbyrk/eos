// AuthResolver adapter. subscription -> the Claude Max/Pro OAuth token;
// env/keychain -> a provider API key. Lazy at launch, never persisted, never
// logged. The token is read here (Node: Keychain / filesystem / process.env), so
// core stays free of those concerns.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AuthRef } from "../../../contracts/src/backend.ts";
import type { AuthResolver, ResolvedAuth } from "../../../core/src/ports/AuthResolver.ts";

const NONE: ResolvedAuth = { scheme: "none" };

type TokenReader = () => string | null;

// Read the CLI's cached OAuth access token from the live credential store (macOS
// Keychain "Claude Code-credentials" / ~/.claude/.credentials.json). This is read
// FIRST on every resolve so a subscription switched after daemon launch is picked
// up without a restart. Expired store tokens are rejected (return null) so a valid
// env token can shadow them.
function readStoreSubscriptionToken(): string | null {
  try {
    const raw =
      process.platform === "darwin"
        ? execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8" })
        : readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const oauth = (parsed.claudeAiOauth ?? parsed) as Record<string, unknown>;
    const token = typeof oauth.accessToken === "string" ? oauth.accessToken : null;
    if (!token) return null;
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= Date.now()) return null;
    return token;
  } catch {
    return null;
  }
}

// The long-lived setup-token from CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`).
// Frozen at daemon launch, so it is the FALLBACK — used only when the live store
// yields nothing (non-mac / CI with no keychain or credentials file).
function readEnvSubscriptionToken(): string | null {
  return process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || null;
}

function readSubscriptionToken(readStore: TokenReader = readStoreSubscriptionToken): string | null {
  return readStore() ?? readEnvSubscriptionToken();
}

function readKeychainSecret(service: string): string | null {
  try {
    const v = execFileSync("security", ["find-generic-password", "-s", service, "-w"], { encoding: "utf8" }).trim();
    return v || null;
  } catch {
    return null;
  }
}

// Companion to readKeychainSecret: store a provider API key in the macOS Keychain
// under `service`, BY REFERENCE — the POST /api/backends route persists only the
// auth:{kind:"keychain",ref:service} reference to config.json, never the raw key.
// `-U` updates an existing item so re-adding a provider rotates the key in place.
// Throws on non-darwin or a security(1) failure (the route surfaces it).
// NOTE (m5): the secret is passed via argv (`-w <secret>`), briefly visible to a
// same-user `ps`. `security add-generic-password` exposes no stdin/file channel for
// the password, so there is no clean mitigation — accepted as a same-user-only
// exposure; the key never reaches config.json/SQLite/logs/events.
export function writeKeychainSecret(service: string, secret: string): void {
  if (process.platform !== "darwin") {
    throw new Error("Keychain storage is only supported on macOS");
  }
  execFileSync("security", ["add-generic-password", "-U", "-s", service, "-a", service, "-w", secret], { encoding: "utf8" });
}

export function createSubscriptionAuthResolver(deps?: { readStore?: TokenReader }): AuthResolver {
  return {
    async resolve(auth: AuthRef | undefined): Promise<ResolvedAuth> {
      const kind = auth?.kind ?? "subscription";
      if (kind === "subscription") {
        const token = readSubscriptionToken(deps?.readStore);
        return token ? { scheme: "oauth", token } : NONE;
      }
      if (kind === "env") {
        const key = auth?.ref ? process.env[auth.ref]?.trim() : undefined;
        return key ? { scheme: "apikey", apiKey: key } : NONE;
      }
      if (kind === "keychain") {
        const key = auth?.ref ? readKeychainSecret(auth.ref) : null;
        return key ? { scheme: "apikey", apiKey: key } : NONE;
      }
      return NONE;
    },
  };
}
