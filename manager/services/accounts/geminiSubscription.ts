// Sign in with Google — the Gemini CLI's own "Log in with Google", driven over
// ACP (`authenticate` with the oauth-personal method). The CLI opens the Google
// sign-in page itself, serves the OAuth callback locally and writes its login
// (~/.gemini: the credentials + the selected method), so there is no credential
// for Eos to store. In ACP mode it hands back no sign-in link, so the UI offers
// only Cancel. Credentials that are still valid make the call return at once.

import { errMsg } from "../../../contracts/src/util.ts";
import { GOOGLE_LOGIN_METHOD } from "../../../infra/src/auth/geminiLogin.ts";
import type { AcpClient, AcpOptions } from "../../backends/gemini/AcpClient.ts";
import type { SignInFlow, SubscriptionProvider } from "./SignInService.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export interface GeminiSubscriptionDeps {
  binary: string | null;
  env(): Record<string, string | undefined>;
  open(opts: AcpOptions): Promise<AcpClient>;
  /** Removes the Gemini CLI's Google login (clearGeminiLogin). */
  clearLogin(): void;
  timeoutMs?: number;
}

const NOT_INSTALLED = "Gemini CLI isn't installed on this Mac — install it, then sign in again.";

export function startGeminiSignIn(deps: GeminiSubscriptionDeps): SignInFlow {
  let client: AcpClient | null = null;
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
    c.onExit(() => finish(new Error("Gemini CLI stopped before the sign-in finished.")));
    await c.request("authenticate", { methodId: GOOGLE_LOGIN_METHOD });
    finish("");
  })().catch((e) => finish(new Error(errMsg(e))));

  return {
    result,
    submitCode() { /* the callback reaches the Gemini CLI directly; there is no code to paste */ },
    // Closing the CLI takes its local callback server down with it.
    cancel() { finish(new Error("Sign-in cancelled.")); },
  };
}

export function createGeminiSubscription(deps: GeminiSubscriptionDeps): SubscriptionProvider {
  return {
    id: "gemini",
    acceptsCode: false,
    startSignIn: () => startGeminiSignIn(deps),
    saveCredential() { /* the Gemini CLI wrote its own login */ },
    signOut: () => deps.clearLogin(),
  };
}
