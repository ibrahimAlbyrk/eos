import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_REFRESH_LOCK, createClaudeLoginRefresher } from "../auth/ClaudeLoginRefresher.ts";

const NOW = 1_000_000_000_000;
const SCOPES = ["user:inference", "user:profile"];

describe("ClaudeLoginRefresher", () => {
  let store: string;
  let oauth: Record<string, unknown>;
  let exchanges: { refreshToken: string; lockHeld: boolean }[];

  beforeEach(() => {
    store = mkdtempSync(join(tmpdir(), "eos-refresh-"));
    oauth = { accessToken: "a1", refreshToken: "r1", expiresAt: NOW - 1, scopes: SCOPES };
    exchanges = [];
  });
  afterEach(() => rmSync(store, { recursive: true, force: true }));

  const lockPath = () => join(store, CLAUDE_REFRESH_LOCK);
  const refresher = (opts: { lockWaitMs?: number } = {}) => createClaudeLoginRefresher({
    binary: "claude",
    readOAuth: () => oauth,
    exchange: async (_dir, refreshToken) => {
      exchanges.push({ refreshToken, lockHeld: existsSync(lockPath()) });
      await new Promise((r) => setTimeout(r, 10));
      oauth = { accessToken: "a2", refreshToken: "r2", expiresAt: NOW + 3_600_000, scopes: SCOPES };
    },
    now: () => NOW,
    retryMs: 5,
    ...opts,
  });

  it("renews a lapsed login once, however many callers ask at the same time", async () => {
    const r = refresher();
    await Promise.all([r.renew(store), r.renew(store), r.renew(store)]);
    assert.deepEqual(exchanges, [{ refreshToken: "r1", lockHeld: true }]);
    assert.equal(existsSync(lockPath()), false);
  });

  it("leaves a login whose token is still good alone", async () => {
    oauth.expiresAt = NOW + 60_000;
    await refresher().renew(store);
    assert.equal(exchanges.length, 0);
  });

  it("renews a rejected token only while it is still the one in the store", async () => {
    oauth.expiresAt = NOW + 60_000;
    await refresher().renew(store, "a0");
    assert.equal(exchanges.length, 0);
    await refresher().renew(store, "a1");
    assert.deepEqual(exchanges.map((e) => e.refreshToken), ["r1"]);
  });

  it("waits for a claude process holding the lock, then skips a login it already renewed", async () => {
    mkdirSync(lockPath());
    const done = refresher().renew(store);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(exchanges.length, 0);
    oauth = { accessToken: "b2", refreshToken: "s2", expiresAt: NOW + 3_600_000, scopes: SCOPES };
    rmSync(lockPath(), { recursive: true });
    await done;
    assert.equal(exchanges.length, 0);
  });

  it("takes over a lock its holder abandoned", async () => {
    mkdirSync(lockPath());
    const old = new Date(NOW - 120_000);
    utimesSync(lockPath(), old, old);
    const r = createClaudeLoginRefresher({
      binary: "claude",
      readOAuth: () => oauth,
      exchange: async (_dir, refreshToken) => { exchanges.push({ refreshToken, lockHeld: existsSync(lockPath()) }); },
      retryMs: 5,
    });
    await r.renew(store);
    assert.deepEqual(exchanges, [{ refreshToken: "r1", lockHeld: true }]);
  });

  it("gives up without renewing when the lock stays held", async () => {
    mkdirSync(lockPath());
    let t = NOW;
    const r = createClaudeLoginRefresher({
      binary: "claude",
      readOAuth: () => oauth,
      exchange: async () => { exchanges.push({ refreshToken: "x", lockHeld: true }); },
      now: () => (t += 10),
      retryMs: 1,
      lockWaitMs: 50,
    });
    await assert.rejects(r.renew(store), /kept renewing/);
    assert.equal(exchanges.length, 0);
    assert.equal(existsSync(lockPath()), true);
  });

  it("releases the lock when the exchange fails", async () => {
    const r = createClaudeLoginRefresher({
      binary: "claude",
      readOAuth: () => oauth,
      exchange: async () => { throw new Error("Login failed: 400"); },
      now: () => NOW,
    });
    await assert.rejects(r.renew(store), /400/);
    assert.equal(existsSync(lockPath()), false);
  });
});
