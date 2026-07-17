// Anthropic credentials for the claude-sdk backend lane, persisted in
// ~/.eos/config.json under `anthropic`. Both optional. When the claude-sdk lane
// spawns a session it injects ONE of these into the child env: authToken (the
// Max/Pro OAuth setup-token → CLAUDE_CODE_OAUTH_TOKEN) WINS over apiKey (the
// metered key → ANTHROPIC_API_KEY). Exporting the OAuth token up front sidesteps
// the SDK's mid-session token refresh. The claude-cli (PTY) lane is unaffected.

import { z } from "zod";

export const AnthropicConfigSchema = z.object({
  apiKey: z.string().optional(),
  authToken: z.string().optional(),
});
export type AnthropicConfig = z.infer<typeof AnthropicConfigSchema>;

// The redacted view the UI receives — never the raw secrets, only whether each
// credential is set (mirrors the backends route, which never echoes the key).
export const AnthropicConfigStatusSchema = z.object({
  apiKeySet: z.boolean(),
  authTokenSet: z.boolean(),
});
export type AnthropicConfigStatus = z.infer<typeof AnthropicConfigStatusSchema>;
