import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePlanLoginStore, parsePlanLogins } from "../persistence/FilePlanLoginStore.ts";
import { createPlanLoginDirs } from "../auth/planLoginDirs.ts";
import { readClaudeAccountEmail } from "../auth/SubscriptionAuthResolver.ts";
import { EMPTY_PLAN_LOGINS } from "../../../core/src/domain/plan-logins.ts";

const login = { id: "l1", provider: "anthropic", label: "Personal", email: "me@example.com", storeDir: "/acc/claude", createdAt: "t" };

describe("FilePlanLoginStore", () => {
  it("round-trips the registry in a 0600 file; a missing or broken file is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "eos-logins-"));
    const store = new FilePlanLoginStore(join(dir, "logins.json"));
    assert.deepEqual(store.load(), EMPTY_PLAN_LOGINS);
    store.save({ logins: [login], defaults: { anthropic: "l1" } });
    assert.deepEqual(store.load(), { logins: [login], defaults: { anthropic: "l1" } });
    assert.equal(statSync(join(dir, "logins.json")).mode & 0o777, 0o600);
    writeFileSync(join(dir, "logins.json"), "{nope");
    assert.deepEqual(store.load(), EMPTY_PLAN_LOGINS);
  });

  it("drops invalid entries and defaults that name no login", () => {
    const reg = parsePlanLogins({ logins: [login, { id: "x" }, null], defaults: { anthropic: "l1", openai: "gone" } });
    assert.deepEqual(reg, { logins: [login], defaults: { anthropic: "l1" } });
  });
});

describe("plan login store dirs", () => {
  it("creates a private dir per sign-in, discards only its own, trashes a signed-out one", () => {
    const acc = mkdtempSync(join(tmpdir(), "eos-acc-"));
    const dirs = createPlanLoginDirs(acc);
    const fresh = dirs.create("anthropic", "lg-1");
    assert.equal(fresh, join(acc, "claude-lg-1"));
    assert.equal(statSync(fresh).mode & 0o777, 0o700);
    dirs.discard(fresh);
    assert.equal(existsSync(fresh), false);

    const legacy = join(acc, "claude");
    mkdirSync(legacy);
    dirs.discard(legacy);
    assert.equal(existsSync(legacy), true);
    dirs.trash(legacy);
    assert.equal(existsSync(legacy), false);
    assert.match(readdirSync(join(acc, ".trash"))[0], /^claude\./);
  });
});

describe("readClaudeAccountEmail", () => {
  it("reads the email the CLI recorded in the store", () => {
    const dir = mkdtempSync(join(tmpdir(), "eos-store-"));
    assert.equal(readClaudeAccountEmail(dir), undefined);
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: " me@example.com " } }));
    assert.equal(readClaudeAccountEmail(dir), "me@example.com");
  });
});
