import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGeminiSubscription, startGeminiSignIn, type GeminiSubscriptionDeps } from "../accounts/geminiSubscription.ts";
import { fakeAppServer } from "../../backends/codex/__tests__/fakeAppServer.ts";

const tick = () => new Promise((r) => setTimeout(r, 5));

function setup(over: Partial<GeminiSubscriptionDeps> = {}) {
  let finishAuth!: () => void;
  const server = fakeAppServer({ authenticate: () => new Promise<void>((r) => { finishAuth = r; }) });
  let cleared = 0;
  const deps: GeminiSubscriptionDeps = {
    binary: "/bin/gemini",
    env: () => ({}),
    open: async () => server,
    clearLogin: () => { cleared++; },
    ...over,
  };
  return { server, deps, finishAuth: () => finishAuth(), cleared: () => cleared };
}

describe("Sign in with Google (Gemini CLI)", () => {
  it("asks the Gemini CLI for its Google login and resolves when it's done", async () => {
    const t = setup();
    const flow = startGeminiSignIn(t.deps);
    await tick();
    assert.deepEqual(t.server.requests.map((r) => [r.method, r.params]), [["authenticate", { methodId: "oauth-personal" }]]);
    t.finishAuth();
    assert.equal(await flow.result, "");
    assert.equal(t.server.closed, true);
  });

  it("fails with the Gemini CLI's error", async () => {
    const t = setup();
    t.server.handlers.authenticate = () => { throw new Error("This account requires setting GOOGLE_CLOUD_PROJECT"); };
    await assert.rejects(startGeminiSignIn(t.deps).result, /GOOGLE_CLOUD_PROJECT/);
  });

  it("cancel closes the CLI (and its callback server)", async () => {
    const t = setup();
    const flow = startGeminiSignIn(t.deps);
    await tick();
    flow.cancel();
    await assert.rejects(flow.result, /cancelled/);
    assert.equal(t.server.closed, true);
  });

  it("fails clearly when the Gemini CLI isn't installed, or dies mid-login", async () => {
    await assert.rejects(startGeminiSignIn(setup({ binary: null }).deps).result, /isn't installed/);

    const t = setup();
    const flow = startGeminiSignIn(t.deps);
    await tick();
    t.server.crash(1);
    await assert.rejects(flow.result, /stopped/);
  });

  it("takes no pasted code; signing out clears the shared login", async () => {
    const t = setup();
    const provider = createGeminiSubscription(t.deps);
    assert.equal(provider.id, "gemini");
    assert.equal(provider.acceptsCode, false);
    await provider.signOut();
    assert.equal(t.cleared(), 1);
  });
});
