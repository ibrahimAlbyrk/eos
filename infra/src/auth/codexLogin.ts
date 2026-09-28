// The Codex login on this machine — the ChatGPT sign-in the Codex CLI keeps in
// $CODEX_HOME/auth.json (default ~/.codex), shared with the Codex / ChatGPT
// desktop apps and written by Eos's own "Sign in with ChatGPT". Read live on
// every call, never cached, never logged. The plan comes from the id token's
// claims (display only — the token is not verified here).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CodexLogin {
  present: boolean;
  /** chatgpt_plan_type: "plus", "pro", "prolite", "team", … */
  plan?: string;
}

const NO_LOGIN: CodexLogin = { present: false };

function planFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  try {
    const claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    return typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : null;
  } catch {
    return null;
  }
}

export function codexHome(env: Record<string, string | undefined> = process.env): string {
  return env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

export function readCodexLogin(env: Record<string, string | undefined> = process.env): CodexLogin {
  try {
    const auth = JSON.parse(readFileSync(join(codexHome(env), "auth.json"), "utf8")) as Record<string, unknown>;
    // An API-key login is not a plan sign-in.
    if (auth.auth_mode !== undefined && auth.auth_mode !== "chatgpt") return NO_LOGIN;
    const tokens = auth.tokens as Record<string, unknown> | null | undefined;
    if (!tokens || (typeof tokens.refresh_token !== "string" && typeof tokens.access_token !== "string")) return NO_LOGIN;
    const plan = planFromIdToken(tokens.id_token);
    return { present: true, ...(plan ? { plan } : {}) };
  } catch {
    return NO_LOGIN;
  }
}
