import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearGeminiLogin, readGeminiLogin } from "../auth/geminiLogin.ts";

function home(files: { settings?: string; creds?: unknown }): string {
  const dir = mkdtempSync(join(tmpdir(), "eos-gemini-"));
  if (files.settings !== undefined) writeFileSync(join(dir, "settings.json"), files.settings);
  if (files.creds !== undefined) writeFileSync(join(dir, "oauth_creds.json"), JSON.stringify(files.creds));
  return dir;
}

const GOOGLE = `{
  // the CLI tolerates comments
  "security": { "auth": { "selectedType": "oauth-personal" } }
}`;

describe("readGeminiLogin", () => {
  it("Google credentials with Google selected as the auth method", () => {
    assert.deepEqual(readGeminiLogin(home({ settings: GOOGLE, creds: { access_token: "a", refresh_token: "r" } })), { present: true });
    assert.deepEqual(readGeminiLogin(home({ settings: `{"selectedAuthType":"oauth-personal"}`, creds: { refresh_token: "r" } })), { present: true });
  });

  it("another auth method, no tokens, or no files is not a plan sign-in", () => {
    const apiKey = `{"security":{"auth":{"selectedType":"gemini-api-key"}}}`;
    assert.deepEqual(readGeminiLogin(home({ settings: apiKey, creds: { refresh_token: "r" } })), { present: false });
    assert.deepEqual(readGeminiLogin(home({ settings: GOOGLE, creds: {} })), { present: false });
    assert.deepEqual(readGeminiLogin(home({ settings: GOOGLE })), { present: false });
    assert.deepEqual(readGeminiLogin(home({})), { present: false });
  });
});

describe("clearGeminiLogin", () => {
  it("removes the cached credentials, and is a no-op when there are none", () => {
    const dir = home({ settings: GOOGLE, creds: { refresh_token: "r" } });
    clearGeminiLogin(dir);
    assert.equal(existsSync(join(dir, "oauth_creds.json")), false);
    assert.equal(existsSync(join(dir, "settings.json")), true);
    assert.deepEqual(readGeminiLogin(dir), { present: false });
    clearGeminiLogin(dir);
  });
});
