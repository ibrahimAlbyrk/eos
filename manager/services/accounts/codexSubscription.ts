// Sign in with ChatGPT — drives the official `codex login` with Eos's own
// CODEX_HOME in its env (see env()). The CLI opens the browser itself, serves the
// OAuth callback locally and writes the login ($CODEX_HOME/auth.json), so there
// is no credential for Eos to store — it succeeds by exiting 0. Eos only watches
// its output for the sign-in URL (the UI's "Copy link"). The app-server's
// account/login/start isn't used: its sign-in page stalls once the account is
// picked, as it names Eos rather than the Codex CLI as the client. Signing out is
// the app-server's account/logout.

import { spawn as nodeSpawn } from "node:child_process";
import { errMsg } from "../../../contracts/src/util.ts";
import type { AppServerClient, AppServerOptions } from "../../backends/codex/AppServerClient.ts";
import type { SpawnFn } from "../../backends/stdioRpc.ts";
import type { SignInFlow, SubscriptionProvider } from "./SignInService.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT = 16 * 1024;
const URL_RE = /https:\/\/auth\.openai\.com\/oauth\/authorize\?\S+/;

export interface CodexSubscriptionDeps {
  binary: string | null;
  env(): Record<string, string | undefined>;
  open(opts: AppServerOptions): Promise<AppServerClient>;
  spawnFn?: SpawnFn;
  timeoutMs?: number;
}

const NOT_INSTALLED = "Codex isn't installed on this Mac — install the Codex CLI or the ChatGPT app, then sign in again.";

export function startCodexSignIn(deps: CodexSubscriptionDeps, handlers: { onUrl(url: string): void }): SignInFlow {
  let settled = false;
  let resolveResult!: (v: string) => void;
  let rejectResult!: (e: Error) => void;
  const result = new Promise<string>((res, rej) => { resolveResult = res; rejectResult = rej; });
  result.catch(() => {});

  if (!deps.binary) {
    rejectResult(new Error(NOT_INSTALLED));
    return { result, submitCode() {}, cancel() {} };
  }

  const spawnFn = deps.spawnFn ?? ((cmd, args, o) => nodeSpawn(cmd, args, { env: o.env, stdio: ["pipe", "pipe", "pipe"] }));
  const child = spawnFn(deps.binary, ["login"], { env: deps.env() });
  child.stdin.end();

  let output = "";
  let urlSeen = false;
  const finish = (outcome: string | Error): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // Killing the CLI takes its local callback server down with it.
    if (child.exitCode === null) child.kill();
    if (typeof outcome === "string") resolveResult(outcome);
    else rejectResult(outcome);
  };
  const timer = setTimeout(() => finish(new Error("Sign-in timed out. Try again.")), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref?.();

  const onOutput = (chunk: Buffer | string): void => {
    output = (output + chunk.toString()).slice(-MAX_OUTPUT);
    const url = output.match(URL_RE)?.[0];
    if (url && !urlSeen) {
      urlSeen = true;
      handlers.onUrl(url);
    }
  };
  child.stdout.on("data", onOutput);
  child.stderr.on("data", onOutput);
  child.on("error", (e) => finish(new Error(errMsg(e))));
  child.on("exit", (code) => {
    if (code === 0) return finish("");
    const last = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1);
    finish(new Error(last ? `Sign-in ended: ${last.slice(0, 200)}` : `Sign-in ended (exit ${code ?? "killed"}).`));
  });

  return {
    result,
    submitCode() { /* the callback reaches the Codex CLI directly; there is no code to paste */ },
    cancel() { finish(new Error("Sign-in cancelled.")); },
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
