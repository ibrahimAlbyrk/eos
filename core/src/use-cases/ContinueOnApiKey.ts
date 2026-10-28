// ContinueOnApiKey — on the accounts_exhausted row the user chose to go on
// billing this session per token: it moves to the provider's API key (its later
// launches stay there) and the turn picks back up. Never automatic.

import { moveSession, type MoveSessionDeps } from "./SwitchSessionAccount.ts";

export interface ContinueOnApiKeyDeps extends MoveSessionDeps {
  apiKeySet(): boolean;
}

export async function continueOnApiKey(
  deps: ContinueOnApiKeyDeps,
  input: { workerId: string; provider: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!deps.apiKeySet()) return { ok: false, error: "No API key is set — add one in Settings › Accounts." };
  return moveSession(deps, input.workerId, { apiKey: true }, { provider: input.provider, to: "API key", reason: "api_key" });
}
