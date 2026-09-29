// A Gemini CLI Google sign-in: the OAuth credentials the CLI keeps in
// <home>/oauth_creds.json, with "Log in with Google" as its selected auth method in
// <home>/settings.json. Eos runs the CLI with its own GEMINI_CLI_HOME, so it reads
// only the login its "Sign in with Google" wrote, never the user's ~/.gemini. Read
// live on every call, never cached, never logged.

import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GeminiLogin {
  present: boolean;
}

/** The auth method id the Gemini CLI records for "Log in with Google". */
export const GOOGLE_LOGIN_METHOD = "oauth-personal";

const NO_LOGIN: GeminiLogin = { present: false };

// settings.json may carry comments, which the CLI tolerates, so the method is
// matched rather than parsed. `selectedAuthType` is the pre-v2 settings key.
const SELECTED_AUTH_RE = /"(?:selectedType|selectedAuthType)"\s*:\s*"([^"]*)"/;

/** The CLI's dir under `cliHome` — what it gets as GEMINI_CLI_HOME, else the user's home. */
export function geminiHome(cliHome: string = homedir()): string {
  return join(cliHome, ".gemini");
}

// Credentials alone aren't enough: the CLI's sessions run on the SELECTED method,
// so with an API key selected they would never touch the Google plan.
export function readGeminiLogin(home: string = geminiHome()): GeminiLogin {
  try {
    const settings = readFileSync(join(home, "settings.json"), "utf8");
    if (SELECTED_AUTH_RE.exec(settings)?.[1] !== GOOGLE_LOGIN_METHOD) return NO_LOGIN;
    const creds = JSON.parse(readFileSync(join(home, "oauth_creds.json"), "utf8")) as Record<string, unknown>;
    return typeof creds.refresh_token === "string" || typeof creds.access_token === "string" ? { present: true } : NO_LOGIN;
  } catch {
    return NO_LOGIN;
  }
}

// Signing out removes the cached Google credentials, as the Gemini CLI's own
// logout does.
export function clearGeminiLogin(home: string = geminiHome()): void {
  rmSync(join(home, "oauth_creds.json"), { force: true });
}
