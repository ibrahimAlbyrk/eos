// AuthResolver — turns a BackendProfile's AuthRef into concrete credentials at
// launch. Resolution is LAZY (per spawn), NEVER persisted to SQLite, NEVER
// logged. subscription -> the Claude Max/Pro OAuth token (no metered key);
// env/keychain -> a provider API key. The adapter lives in infra (Keychain /
// filesystem / process.env are Node concerns).

import type { AuthRef } from "../../../contracts/src/backend.ts";

export interface ResolvedAuth {
  readonly scheme: "oauth" | "apikey" | "none";
  /** oauth: the Claude subscription / setup-token (bills the Max/Pro plan). Absent
   *  on oauth when the only credential is a refreshable login the claude binary
   *  reads from its own store. */
  readonly token?: string;
  /** apikey: the provider API key (bills the provider's metered API). */
  readonly apiKey?: string;
  /** Optional provider base URL (self-host / proxy / Azure) for api-key backends. */
  readonly baseUrl?: string;
}

export interface AuthResolver {
  /** Resolve credentials for an AuthRef. Omitted ref ⇒ subscription. Returns
   *  scheme:"none" when the referenced credential is absent — the caller then
   *  refuses or falls back explicitly rather than billing silently. */
  resolve(auth: AuthRef | undefined): Promise<ResolvedAuth>;
}
