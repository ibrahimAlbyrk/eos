// Sign in with ChatGPT — the Codex app-server's own login (account/login/start,
// type "chatgpt"): it serves the OAuth callback locally and writes the Codex
// login ($CODEX_HOME/auth.json) itself, so there is no credential for Eos to
// store. Eos opens the returned sign-in page in the browser and waits for
// account/login/completed. Signing out is account/logout — the Codex login is
// shared with the Codex / ChatGPT apps on this Mac, so it signs those out too.

import { errMsg } from "../../../contracts/src/util.ts";
import type { AppServerClient, AppServerOptions } from "../../backends/codex/AppServerClient.ts";
import type { SignInFlow, SubscriptionProvider } from "./SignInService.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export interface CodexSubscriptionDeps {
  binary: string | null;
  env(): Record<string, string | undefined>;
  open(opts: AppServerOptions): Promise<AppServerClient>;
  openBrowser(url: string): void;
  timeoutMs?: number;
}

const NOT_INSTALLED = "Codex isn't installed on this Mac — install the Codex CLI or the ChatGPT app, then sign in again.";

export function startCodexSignIn(deps: CodexSubscriptionDeps, handlers: { onUrl(url: string): void }): SignInFlow {
  let client: AppServerClient | null = null;
  let loginId: string | null = null;
  let settled = false;
  let resolveResult!: (v: string) => void;
  let rejectResult!: (e: Error) => void;
  const result = new Promise<string>((res, rej) => { resolveResult = res; rejectResult = rej; });
  result.catch(() => {});

  const finish = (outcome: string | Error): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    client?.close();
    if (typeof outcome === "string") resolveResult(outcome);
    else rejectResult(outcome);
  };
  const timer = setTimeout(() => finish(new Error("Sign-in timed out. Try again.")), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref?.();

  void (async () => {
    if (!deps.binary) throw new Error(NOT_INSTALLED);
    const c = await deps.open({ binary: deps.binary, env: deps.env() });
    client = c;
    if (settled) { c.close(); return; }
    c.onNotification((method, p) => {
      if (method !== "account/login/completed") return;
      if (loginId && typeof p.loginId === "string" && p.loginId !== loginId) return;
      finish(p.success === true ? "" : new Error(typeof p.error === "string" && p.error ? p.error : "Sign-in didn't complete."));
    });
    c.onExit(() => finish(new Error("Codex stopped before the sign-in finished.")));
    const r = await c.request<{ loginId?: string; authUrl?: string }>("account/login/start", { type: "chatgpt" });
    if (!r.authUrl) throw new Error("Codex returned no sign-in page.");
    loginId = r.loginId ?? null;
    handlers.onUrl(r.authUrl);
    deps.openBrowser(r.authUrl);
  })().catch((e) => finish(new Error(errMsg(e))));

  return {
    result,
    submitCode() { /* the callback reaches Codex directly; there is no code to paste */ },
    cancel() {
      if (client && loginId) client.request("account/login/cancel", { loginId }).catch(() => {});
      finish(new Error("Sign-in cancelled."));
    },
  };
}

export function createCodexSubscription(deps: CodexSubscriptionDeps): SubscriptionProvider {
  return {
    id: "openai",
    acceptsCode: false,
    startSignIn: (handlers) => startCodexSignIn(deps, handlers),
    saveCredential() { /* Codex wrote its own login */ },
    async signOut() {
      if (!deps.binary) throw new Error(NOT_INSTALLED);
      const client = await deps.open({ binary: deps.binary, env: deps.env() });
      try {
        await client.request("account/logout", {});
      } finally {
        client.close();
      }
    },
  };
}
