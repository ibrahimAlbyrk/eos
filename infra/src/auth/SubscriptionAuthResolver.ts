// AuthResolver adapter. subscription -> the Eos Claude sign-in (Claude Max/Pro);
// env/keychain -> a provider API key. Lazy at launch, never persisted, never
// logged. The login is read here (Node: Keychain / filesystem), so core stays free
// of those concerns.

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AuthRef } from "../../../contracts/src/backend.ts";
import type { AuthResolver, ResolvedAuth } from "../../../core/src/ports/AuthResolver.ts";
import { buildSubscriptionChildEnv } from "../../../core/src/domain/env-allowlist.ts";

const NONE: ResolvedAuth = { scheme: "none" };

// Points the claude binary's credential store (and only that — settings, skills and
// transcripts stay in ~/.claude) at another dir. Eos sets it to its own dir so
// every claude it runs sees only the Eos sign-in, never the Mac's Claude Code login.
export const CLAUDE_STORE_ENV = "CLAUDE_SECURESTORAGE_CONFIG_DIR";

// A Claude Code login store (macOS Keychain / <dir>/.credentials.json), read live on
// every call so a sign-in or refresh is picked up without a restart. `present` is
// any claude.ai login — even one whose access token lapsed, since the claude binary
// refreshes that itself. `token` is the access token only while it is still valid.
export interface ClaudeCodeLogin {
  present: boolean;
  token: string | null;
  /** The plan the CLI recorded (subscriptionType: "max", "pro", …). */
  plan?: string;
}

const NO_LOGIN: ClaudeCodeLogin = { present: false, token: null };

// The Keychain item the claude binary keeps a store's login in: a store dir set
// through CLAUDE_STORE_ENV gets its own item, suffixed with a hash of that dir.
export function claudeStoreService(storeDir?: string): string {
  if (!storeDir) return "Claude Code-credentials";
  return `Claude Code-credentials-${createHash("sha256").update(storeDir.normalize("NFC")).digest("hex").slice(0, 8)}`;
}

function readClaudeStore(storeDir?: string): Record<string, unknown> | null {
  try {
    const raw =
      process.platform === "darwin"
        ? execFileSync("security", ["find-generic-password", "-s", claudeStoreService(storeDir), "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        : readFileSync(join(storeDir ?? join(homedir(), ".claude"), ".credentials.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return (parsed.claudeAiOauth ?? parsed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The login in `storeDir` (an Eos store), or the Mac's own Claude Code login when omitted. */
export function readClaudeCodeLogin(storeDir?: string): ClaudeCodeLogin {
  const oauth = readClaudeStore(storeDir);
  if (!oauth) return NO_LOGIN;
  const access = typeof oauth.accessToken === "string" ? oauth.accessToken : null;
  const refresh = typeof oauth.refreshToken === "string" ? oauth.refreshToken : null;
  if (!access && !refresh) return NO_LOGIN;
  const expired = typeof oauth.expiresAt === "number" && oauth.expiresAt <= Date.now();
  return {
    present: true,
    token: access && !expired ? access : null,
    ...(typeof oauth.subscriptionType === "string" ? { plan: oauth.subscriptionType } : {}),
  };
}

// Signing out removes the store's login, as `claude auth logout` does.
export function clearClaudeLogin(storeDir: string): void {
  if (process.platform === "darwin") {
    try {
      execFileSync("security", ["delete-generic-password", "-s", claudeStoreService(storeDir)], { stdio: "ignore" });
    } catch {
      // No item: already signed out.
    }
    return;
  }
  rmSync(join(storeDir, ".credentials.json"), { force: true });
}

const execFileAsync = promisify(execFile);
const REFRESH_TIMEOUT_MS = 30_000;

// A store's access token lapses while no claude session runs to renew it. The
// binary's own "login from a refresh token" renews it and rewrites the store, so
// Eos never handles the token exchange. CLAUDE_CONFIG_DIR keeps that login's
// account bookkeeping out of the user's ~/.claude.json.
export async function refreshClaudeLogin(storeDir: string, binary: string): Promise<void> {
  const oauth = readClaudeStore(storeDir);
  const refreshToken = typeof oauth?.refreshToken === "string" ? oauth.refreshToken : null;
  const scopes = Array.isArray(oauth?.scopes) ? oauth.scopes.filter((s): s is string => typeof s === "string") : [];
  if (!refreshToken || !scopes.length) return;
  await execFileAsync(binary, ["auth", "login"], {
    env: {
      ...buildSubscriptionChildEnv(process.env),
      [CLAUDE_STORE_ENV]: storeDir,
      CLAUDE_CONFIG_DIR: storeDir,
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: refreshToken,
      CLAUDE_CODE_OAUTH_SCOPES: scopes.join(" "),
    },
    timeout: REFRESH_TIMEOUT_MS,
  });
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

export function createSubscriptionAuthResolver(deps?: { readLogin?: () => ClaudeCodeLogin }): AuthResolver {
  const readLogin = deps?.readLogin ?? readClaudeCodeLogin;
  return {
    async resolve(auth: AuthRef | undefined): Promise<ResolvedAuth> {
      const kind = auth?.kind ?? "subscription";
      if (kind === "subscription") {
        // No token is exported: the claude child reads the same store and keeps
        // it refreshed for as long as the session runs.
        return readLogin().present ? { scheme: "oauth" } : NONE;
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
