// Renews a Claude store's OAuth login for Eos's own reads (usage, artifacts).
//
// A refresh token is single-use: each renewal returns a new one and spends the
// old. Two renewals racing on one store spend it twice, and the loser — often a
// claude session, which then clears the login — leaves that sign-in signed out.
// The claude binary avoids this among its own processes with a lock in the store
// dir and a re-read once it holds it; its "login from a refresh token" path
// (what Eos runs) skips both. So Eos renews one store at a time, under that same
// lock, and only when the token still needs it once the lock is held.

import { execFile } from "node:child_process";
import { mkdir, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildSubscriptionChildEnv } from "../../../core/src/domain/env-allowlist.ts";
import { CLAUDE_STORE_ENV, readClaudeStore } from "./SubscriptionAuthResolver.ts";

/** The claude binary's own refresh lock, a directory inside the store dir. */
export const CLAUDE_REFRESH_LOCK = ".oauth_refresh.lock";
// The binary's lock settings: a lock untouched for STALE_MS is a dead holder's,
// and a live holder touches it every UPDATE_MS.
const STALE_MS = 60_000;
const UPDATE_MS = 5_000;
const RETRY_MS = 1_000;
const LOCK_WAIT_MS = 45_000;
const EXCHANGE_TIMEOUT_MS = 30_000;

export interface ClaudeLoginRefresher {
  /** Renews `storeDir`'s login when its access token lapsed — or, given the
   *  token a server just rejected, when that is still the token in the store. */
  renew(storeDir: string, rejected?: string): Promise<void>;
}

export interface ClaudeLoginRefresherDeps {
  binary: string;
  readOAuth?: (storeDir: string) => Record<string, unknown> | null;
  exchange?: (storeDir: string, refreshToken: string, scopes: string[]) => Promise<void>;
  now?: () => number;
  retryMs?: number;
  lockWaitMs?: number;
}

const execFileAsync = promisify(execFile);

// The binary's "login from a refresh token" renews the login and rewrites the
// store, so Eos never handles the token exchange. CLAUDE_CONFIG_DIR keeps that
// login's account bookkeeping out of the user's ~/.claude.json.
function binaryExchange(binary: string) {
  return async (storeDir: string, refreshToken: string, scopes: string[]): Promise<void> => {
    await execFileAsync(binary, ["auth", "login"], {
      env: {
        ...buildSubscriptionChildEnv(process.env),
        [CLAUDE_STORE_ENV]: storeDir,
        CLAUDE_CONFIG_DIR: storeDir,
        CLAUDE_CODE_OAUTH_REFRESH_TOKEN: refreshToken,
        CLAUDE_CODE_OAUTH_SCOPES: scopes.join(" "),
      },
      timeout: EXCHANGE_TIMEOUT_MS,
    });
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const errCode = (e: unknown) => (e as { code?: unknown } | undefined)?.code;

export function createClaudeLoginRefresher(deps: ClaudeLoginRefresherDeps): ClaudeLoginRefresher {
  const readOAuth = deps.readOAuth ?? readClaudeStore;
  const exchange = deps.exchange ?? binaryExchange(deps.binary);
  const now = deps.now ?? Date.now;
  const retryMs = deps.retryMs ?? RETRY_MS;
  const lockWaitMs = deps.lockWaitMs ?? LOCK_WAIT_MS;
  const inFlight = new Map<string, Promise<void>>();

  async function withStoreLock(storeDir: string, fn: () => Promise<void>): Promise<void> {
    const lock = join(storeDir, CLAUDE_REFRESH_LOCK);
    const deadline = now() + lockWaitMs;
    await mkdir(storeDir, { recursive: true });
    for (;;) {
      try {
        await mkdir(lock);
        break;
      } catch (e) {
        if (errCode(e) !== "EEXIST") throw e;
      }
      const touched = await stat(lock).then((s) => s.mtimeMs, () => null);
      if (touched === null) continue;
      if (now() - touched > STALE_MS) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (now() >= deadline) throw new Error("Another process kept renewing this Claude sign-in; try again shortly.");
      await sleep(retryMs + Math.random() * retryMs);
    }
    const keepAlive = setInterval(() => {
      const t = new Date();
      utimes(lock, t, t).catch(() => {});
    }, UPDATE_MS);
    keepAlive.unref();
    try {
      await fn();
    } finally {
      clearInterval(keepAlive);
      await rm(lock, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Read under the lock: a claude session (or an earlier renewal) may have
  // renewed the login while this one waited, and its refresh token is the live one.
  async function renewLocked(storeDir: string, rejected: string | undefined): Promise<void> {
    const oauth = readOAuth(storeDir);
    const refreshToken = typeof oauth?.refreshToken === "string" ? oauth.refreshToken : null;
    const scopes = Array.isArray(oauth?.scopes) ? oauth.scopes.filter((s): s is string => typeof s === "string") : [];
    if (!refreshToken || !scopes.length) return;
    const access = typeof oauth?.accessToken === "string" ? oauth.accessToken : null;
    const lapsed = !access || (typeof oauth?.expiresAt === "number" && oauth.expiresAt <= now());
    if (rejected !== undefined ? access !== rejected : !lapsed) return;
    await exchange(storeDir, refreshToken, scopes);
  }

  return {
    renew(storeDir, rejected) {
      const running = inFlight.get(storeDir);
      if (running) return running;
      const run = withStoreLock(storeDir, () => renewLocked(storeDir, rejected))
        .finally(() => inFlight.delete(storeDir));
      inFlight.set(storeDir, run);
      return run;
    },
  };
}
