import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexLogin } from "../auth/codexLogin.ts";

const jwt = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

function home(auth: unknown): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "eos-codex-"));
  if (auth !== undefined) writeFileSync(join(dir, "auth.json"), JSON.stringify(auth));
  return { CODEX_HOME: dir };
}

describe("readCodexLogin", () => {
  it("a ChatGPT login, with the plan from the id token", () => {
    const env = home({ auth_mode: "chatgpt", tokens: { access_token: "a", refresh_token: "r", id_token: jwt({ "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } }) } });
    assert.deepEqual(readCodexLogin(env), { present: true, plan: "pro" });
  });

  it("no plan claim still counts as signed in", () => {
    assert.deepEqual(readCodexLogin(home({ auth_mode: "chatgpt", tokens: { refresh_token: "r", id_token: "garbage" } })), { present: true });
  });

  it("an API-key login, no tokens, or no file is not a plan sign-in", () => {
    assert.deepEqual(readCodexLogin(home({ auth_mode: "apikey", OPENAI_API_KEY: "sk", tokens: null })), { present: false });
    assert.deepEqual(readCodexLogin(home({ auth_mode: "chatgpt", tokens: {} })), { present: false });
    assert.deepEqual(readCodexLogin(home(undefined)), { present: false });
  });
});
