// The Gemini CLI's Google sign-in on this machine: the OAuth credentials it keeps
// in ~/.gemini/oauth_creds.json, with "Log in with Google" as its selected auth
// method in ~/.gemini/settings.json. Shared with the Gemini CLI itself, and
// written by Eos's "Sign in with Google", which drives that same CLI. Read live on
// every call, never cached, never logged.

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

export function geminiHome(): string {
  return join(homedir(), ".gemini");
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
// logout does. They're shared, so the CLI is signed out too; its next start
// offers Google sign-in again.
export function clearGeminiLogin(home: string = geminiHome()): void {
  rmSync(join(home, "oauth_creds.json"), { force: true });
}
