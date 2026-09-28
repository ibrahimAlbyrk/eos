import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCodexSubscription, startCodexSignIn, type CodexSubscriptionDeps } from "../accounts/codexSubscription.ts";
import { fakeAppServer } from "../../backends/codex/__tests__/fakeAppServer.ts";

const tick = () => new Promise((r) => setTimeout(r, 5));

function setup(over: Partial<CodexSubscriptionDeps> = {}) {
  const server = fakeAppServer({ "account/login/start": () => ({ type: "chatgpt", loginId: "L1", authUrl: "https://auth.openai.com/x" }) });
  const opened: string[] = [];
  const deps: CodexSubscriptionDeps = {
    binary: "/bin/codex",
    env: () => ({}),
    open: async () => server,
    openBrowser: (url) => opened.push(url),
    ...over,
  };
  return { server, opened, deps };
}

describe("Sign in with ChatGPT (Codex)", () => {
  it("opens the sign-in page, reports it, and resolves when Codex says the login completed", async () => {
    const t = setup();
    const urls: string[] = [];
    const flow = startCodexSignIn(t.deps, { onUrl: (u) => urls.push(u) });
    await tick();
    assert.deepEqual(t.server.requests.map((r) => [r.method, r.params]), [["account/login/start", { type: "chatgpt" }]]);
    assert.deepEqual(urls, ["https://auth.openai.com/x"]);
    assert.deepEqual(t.opened, ["https://auth.openai.com/x"]);
    t.server.emit("account/login/completed", { loginId: "L1", success: true, error: null });
    assert.equal(await flow.result, "");
    assert.equal(t.server.closed, true);
  });

  it("ignores another login's completion; fails with Codex's error", async () => {
    const t = setup();
    const flow = startCodexSignIn(t.deps, { onUrl: () => {} });
    await tick();
    t.server.emit("account/login/completed", { loginId: "OTHER", success: true });
    t.server.emit("account/login/completed", { loginId: "L1", success: false, error: "access denied" });
    await assert.rejects(flow.result, /access denied/);
  });

  it("cancel cancels the login on the server", async () => {
    const t = setup();
    const flow = startCodexSignIn(t.deps, { onUrl: () => {} });
    await tick();
    flow.cancel();
    await assert.rejects(flow.result, /cancelled/);
    assert.deepEqual(t.server.requests.at(-1), { method: "account/login/cancel", params: { loginId: "L1" } });
  });

  it("fails clearly when Codex isn't installed, or dies mid-login", async () => {
    const none = startCodexSignIn(setup({ binary: null }).deps, { onUrl: () => {} });
    await assert.rejects(none.result, /isn't installed/);

    const t = setup();
    const flow = startCodexSignIn(t.deps, { onUrl: () => {} });
    await tick();
    t.server.crash(1);
    await assert.rejects(flow.result, /stopped/);
  });

  it("takes no pasted code; signing out logs Codex out", async () => {
    const t = setup();
    const provider = createCodexSubscription(t.deps);
    assert.equal(provider.id, "openai");
    assert.equal(provider.acceptsCode, false);
    await provider.signOut();
    assert.deepEqual(t.server.requests.at(-1), { method: "account/logout", params: {} });
    assert.equal(t.server.closed, true);
  });
});
