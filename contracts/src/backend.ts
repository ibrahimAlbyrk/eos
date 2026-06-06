// Backend configuration model — named profiles that say WHICH agent backend +
// model an orchestrator/worker runs on. Persisted per-worker (backend_kind /
// backend_profile columns) and declared in config (backends registry +
// per-role defaults). Claude-CLI is the default so absent config = today.
//
// BackendKind itself lives in canonical.ts (the envelope needs it); we build on
// it here rather than redefining.

import { z } from "zod";
import { UnknownRecordSchema } from "./shared.ts";
import { BackendKindSchema } from "./canonical.ts";

// Credentials are a REFERENCE, never a raw secret. `subscription` = the user's
// logged-in Claude (claude-cli, no secret); `env` ref = an env-var name;
// `keychain` ref = a macOS Keychain service id. Resolved lazily at launch in
// infra, never persisted to SQLite, never logged.
export const AuthRefSchema = z
  .object({
    kind: z.enum(["subscription", "env", "keychain"]),
    ref: z.string().optional(),
  })
  .strict();
export type AuthRef = z.infer<typeof AuthRefSchema>;

export const BackendProfileSchema = z
  .object({
    kind: BackendKindSchema,
    model: z.string(),
    baseUrl: z.string().url().optional(), // self-host / proxy / Azure endpoint
    auth: AuthRefSchema.optional(), // omitted ⇒ subscription (claude-cli)
    pricing: z.string().optional(), // price-table key; defaults to `${kind}:${model}`
    // claude-cli is subscription-paid ⇒ "included"; API kinds ⇒ "billed".
    costMode: z.enum(["billed", "included"]).optional(),
    params: UnknownRecordSchema.optional(), // effort, temperature, reasoning, …
  })
  .strict();
export type BackendProfile = z.infer<typeof BackendProfileSchema>;

// Per-role default selection (names into the backends registry).
export const BackendDefaultsSchema = z
  .object({
    orchestrator: z.object({ backend: z.string() }).partial(),
    worker: z.object({ backend: z.string() }).partial(),
  })
  .partial();
export type BackendDefaults = z.infer<typeof BackendDefaultsSchema>;
