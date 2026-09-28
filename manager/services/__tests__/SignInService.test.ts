import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SignInService, type SignInFlow, type SubscriptionProvider } from "../accounts/SignInService.ts";

function controllableProvider(id = "anthropic") {
  const saved: string[] = [];
  let signedOut = 0;
  const flows: Array<{ onUrl(u: string): void; resolve(c: string): void; reject(e: Error): void; codes: string[]; cancelled: boolean }> = [];
  const provider: SubscriptionProvider = {
    id,
    startSignIn(handlers) {
      let resolve!: (c: string) => void;
      let reject!: (e: Error) => void;
      const result = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
      result.catch(() => {});
      const f = { onUrl: handlers.onUrl, resolve, reject, codes: [] as string[], cancelled: false };
      flows.push(f);
      const flow: SignInFlow = {
        result,
        submitCode: (c) => { f.codes.push(c); },
        cancel: () => { f.cancelled = true; reject(new Error("cancelled")); },
      };
      return flow;
    },
    saveCredential: (c) => { saved.push(c); },
    signOut: () => { signedOut++; },
  };
  return { provider, flows, saved, get signedOut() { return signedOut; } };
}

const tick = () => new Promise((r) => setImmediate(r));

function service(p = controllableProvider()) {
  let n = 0;
  let changes = 0;
  const svc = new SignInService({ providers: [p.provider], newId: () => `s${++n}`, onChange: () => { changes++; }, keepFinishedMs: 10 });
  return { svc, p, get changes() { return changes; } };
}

describe("SignInService", () => {
  it("starting → waiting (with the URL) → succeeded, saving the credential", async () => {
    const t = service();
    const s = t.svc.start("anthropic");
    assert.equal(s.state, "starting");
    t.p.flows[0].onUrl("https://claude.ai/oauth/authorize?x");
    assert.deepEqual(t.svc.get(s.id), { id: s.id, provider: "anthropic", state: "waiting", codeEntry: false, url: "https://claude.ai/oauth/authorize?x" });
    t.p.flows[0].resolve("tok");
    await tick();
    assert.equal(t.svc.get(s.id)?.state, "succeeded");
    assert.deepEqual(t.p.saved, ["tok"]);
    assert.equal(t.changes, 1);
  });

  it("a failed flow surfaces its reason and saves nothing", async () => {
    const t = service();
    const s = t.svc.start("anthropic");
    t.p.flows[0].reject(new Error("Claude Code isn't installed"));
    await tick();
    assert.deepEqual(t.svc.get(s.id), { id: s.id, provider: "anthropic", state: "failed", codeEntry: false, error: "Claude Code isn't installed" });
    assert.deepEqual(t.p.saved, []);
  });

  it("cancel stops the flow and ignores a late credential", async () => {
    const t = service();
    const s = t.svc.start("anthropic");
    assert.equal(t.svc.cancel(s.id), true);
    assert.equal(t.p.flows[0].cancelled, true);
    t.p.flows[0].resolve("late");
    await tick();
    assert.equal(t.svc.get(s.id)?.state, "cancelled");
    assert.deepEqual(t.p.saved, []);
    assert.equal(t.svc.cancel(s.id), false);
  });

  it("a second start for the same provider cancels the first", () => {
    const t = service();
    const a = t.svc.start("anthropic");
    const b = t.svc.start("anthropic");
    assert.equal(t.svc.get(a.id)?.state, "cancelled");
    assert.equal(t.svc.get(b.id)?.state, "starting");
  });

  it("forwards a code only while the sign-in is active", async () => {
    const t = service();
    const s = t.svc.start("anthropic");
    assert.equal(t.svc.submitCode(s.id, "abc"), true);
    assert.deepEqual(t.p.flows[0].codes, ["abc"]);
    t.svc.cancel(s.id);
    assert.equal(t.svc.submitCode(s.id, "def"), false);
    assert.equal(t.svc.submitCode("nope", "x"), false);
  });

  it("a provider that throws on start fails the session instead of the request", () => {
    const p = controllableProvider();
    p.provider.startSignIn = () => { throw new Error("pty spawn failed"); };
    const t = service(p);
    const s = t.svc.start("anthropic");
    assert.equal(s.state, "failed");
    assert.equal(s.error, "pty spawn failed");
  });

  it("rejects unknown providers; signOut delegates and reports a change", async () => {
    const t = service();
    assert.equal(t.svc.supports("openai"), false);
    assert.throws(() => t.svc.start("openai"), /not supported/);
    await t.svc.signOut("anthropic");
    assert.equal(t.p.signedOut, 1);
    assert.equal(t.changes, 1);
  });

  it("a provider that takes a pasted code says so on the session", () => {
    const p = controllableProvider();
    (p.provider as { acceptsCode?: boolean }).acceptsCode = true;
    assert.equal(service(p).svc.start("anthropic").codeEntry, true);
  });

  it("forgets finished sessions after the keep window", async () => {
    const t = service();
    const s = t.svc.start("anthropic");
    t.svc.cancel(s.id);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(t.svc.get(s.id), null);
  });
});
