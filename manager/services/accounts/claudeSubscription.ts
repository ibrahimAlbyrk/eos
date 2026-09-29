// Sign in with Claude — drives the official `claude auth login` in a PTY, with the
// Eos credential store (CLAUDE_STORE_ENV) in its env, so the login lands in Eos's
// own store instead of the Mac's Claude Code one. The CLI opens the browser
// itself; Eos only watches its output for the sign-in URL (the UI's "Copy link")
// and types a pasted code into its "Paste code here if prompted" field when the
// browser redirect can't reach this machine. The CLI writes the login itself, so
// there is no credential for Eos to store — it succeeds by exiting 0.

import type { SpawnPtyHost } from "../../../spawner/pty-host.ts";
import type { SignInFlow, SubscriptionProvider } from "./SignInService.ts";

// eslint-disable-next-line no-control-regex -- stripping terminal escapes is the point
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex -- stripping terminal escapes is the point
const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex -- stripping terminal escapes is the point
const ESC_RE = /\x1b[@-Z\\-_]/g;
const URL_RE = /https:\/\/[^\s"'<>]+\/oauth\/authorize\?[^\s"'<>]+/;

const MAX_BUFFER = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const CODE_SUBMIT_DELAY_MS = 150;

export function stripAnsi(s: string): string {
  return s.replace(OSC_RE, "").replace(CSI_RE, "").replace(ESC_RE, "");
}

export function parseLoginUrl(raw: string): string | undefined {
  return stripAnsi(raw).match(URL_RE)?.[0];
}

// Why the CLI ended without signing in, in words the UI can show.
export function loginFailure(raw: string, exitCode: number): string {
  const text = stripAnsi(raw);
  if (/command not found: claude|claude: command not found|claude: not found/.test(text)) {
    return "Claude Code isn't installed on this Mac — install it, then sign in again.";
  }
  const last = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1);
  return last ? `Sign-in ended: ${last.slice(0, 200)}` : `Sign-in ended (exit ${exitCode}).`;
}

export interface ClaudeLoginDeps {
  spawnPty: SpawnPtyHost;
  cwd: string;
  /** Must point the CLI at the Eos store (CLAUDE_STORE_ENV). */
  env: Record<string, string | undefined>;
  timeoutMs?: number;
}

export function startClaudeLogin(deps: ClaudeLoginDeps, handlers: { onUrl(url: string): void }): SignInFlow {
  // Wide enough that the URL doesn't wrap onto a second line.
  const pty = deps.spawnPty({
    cwd: deps.cwd, cols: 1000, rows: 40, command: "claude auth login --claudeai", exitAfterCommand: true, env: deps.env,
  });

  let buffer = "";
  let urlSeen = false;
  let settled = false;
  let resolveResult!: (v: string) => void;
  let rejectResult!: (e: Error) => void;
  const result = new Promise<string>((res, rej) => { resolveResult = res; rejectResult = rej; });
  // A cancelled flow rejects with nobody listening; keep that from surfacing as unhandled.
  result.catch(() => {});

  const finish = (outcome: string | Error): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    pty.kill();
    if (typeof outcome === "string") resolveResult(outcome);
    else rejectResult(outcome);
  };
  const timer = setTimeout(() => finish(new Error("Sign-in timed out. Try again.")), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref?.();

  pty.onData((chunk) => {
    buffer = (buffer + chunk).slice(-MAX_BUFFER);
    const url = parseLoginUrl(buffer);
    if (url && !urlSeen) {
      urlSeen = true;
      handlers.onUrl(url);
    }
  });
  pty.onExit((code) => finish(code === 0 ? "" : new Error(loginFailure(buffer, code))));

  return {
    result,
    submitCode(code) {
      if (settled) return;
      pty.write(code.trim());
      setTimeout(() => { if (!settled) pty.write("\r"); }, CODE_SUBMIT_DELAY_MS).unref?.();
    },
    cancel() { finish(new Error("Sign-in cancelled.")); },
  };
}

export function createClaudeSubscription(
  deps: ClaudeLoginDeps & {
    /** The pre-store sign-in kept a setup-token in config; a new sign-in or a sign-out retires it. */
    clearLegacyToken(): void;
    clearLogin(): void;
  },
): SubscriptionProvider {
  return {
    id: "anthropic",
    acceptsCode: true,
    startSignIn: (handlers) => startClaudeLogin(deps, handlers),
    saveCredential: () => deps.clearLegacyToken(),
    signOut: () => {
      deps.clearLogin();
      deps.clearLegacyToken();
    },
  };
}
