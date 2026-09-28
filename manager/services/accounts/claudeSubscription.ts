// Sign in with Claude — drives the official `claude setup-token` in a PTY (an Ink
// TUI, so it needs a TTY). The CLI opens the browser itself; Eos only watches its
// output for the sign-in URL (the UI's "Copy link"), types a pasted code into its
// "Paste code here if prompted" field when the browser redirect can't reach this
// machine, and captures the long-lived token it prints. The token lands in
// config.anthropic.authToken, which the claude lane already exports as
// CLAUDE_CODE_OAUTH_TOKEN. The raw output carries the token, so it is never
// logged and only a bounded tail is kept.

import type { SpawnPtyHost } from "../../../spawner/pty-host.ts";
import type { SignInFlow, SubscriptionProvider } from "./SignInService.ts";

// eslint-disable-next-line no-control-regex -- stripping terminal escapes is the point
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex -- stripping terminal escapes is the point
const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex -- stripping terminal escapes is the point
const ESC_RE = /\x1b[@-Z\\-_]/g;
const URL_RE = /https:\/\/[^\s"'<>]+\/oauth\/authorize\?[^\s"'<>]+/;
// A token counts only once something follows it, so a chunk boundary mid-token
// never yields a truncated credential; `final` (the CLI exited) lifts that.
const TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]{20,}(?=\s)/;
const TOKEN_FINAL_RE = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/;

const MAX_BUFFER = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const CODE_SUBMIT_DELAY_MS = 150;

export function stripAnsi(s: string): string {
  return s.replace(OSC_RE, "").replace(CSI_RE, "").replace(ESC_RE, "");
}

export function parseSetupTokenOutput(raw: string, opts?: { final?: boolean }): { url?: string; token?: string } {
  const text = stripAnsi(raw);
  const url = text.match(URL_RE)?.[0];
  const token = text.match(opts?.final ? TOKEN_FINAL_RE : TOKEN_RE)?.[0];
  return { ...(url ? { url } : {}), ...(token ? { token } : {}) };
}

// Why the CLI ended without a token, in words the UI can show. Only reached when
// no token was printed, so the tail can't leak one.
export function setupTokenFailure(raw: string, exitCode: number): string {
  const text = stripAnsi(raw);
  if (/command not found: claude|claude: command not found|claude: not found/.test(text)) {
    return "Claude Code isn't installed on this Mac — install it, then sign in again.";
  }
  const last = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1);
  return last ? `Sign-in ended: ${last.slice(0, 200)}` : `Sign-in ended (exit ${exitCode}).`;
}

export interface ClaudeSetupTokenDeps {
  spawnPty: SpawnPtyHost;
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs?: number;
}

export function startClaudeSetupToken(deps: ClaudeSetupTokenDeps, handlers: { onUrl(url: string): void }): SignInFlow {
  // Wide enough that neither the URL nor the token wraps onto a second line.
  const pty = deps.spawnPty({
    cwd: deps.cwd, cols: 1000, rows: 40, command: "claude setup-token", exitAfterCommand: true, env: deps.env,
  });

  let buffer = "";
  let urlSeen = false;
  let settled = false;
  let resolveResult!: (token: string) => void;
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
    const { url, token } = parseSetupTokenOutput(buffer);
    if (url && !urlSeen) {
      urlSeen = true;
      handlers.onUrl(url);
    }
    if (token) finish(token);
  });
  pty.onExit((code) => {
    const { token } = parseSetupTokenOutput(buffer, { final: true });
    finish(token ?? new Error(setupTokenFailure(buffer, code)));
  });

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
  deps: ClaudeSetupTokenDeps & { patchConfig(patch: { authToken: string }): void },
): SubscriptionProvider {
  return {
    id: "anthropic",
    acceptsCode: true,
    startSignIn: (handlers) => startClaudeSetupToken(deps, handlers),
    saveCredential: (token) => deps.patchConfig({ authToken: token }),
    signOut: () => deps.patchConfig({ authToken: "" }),
  };
}
