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
import { ProviderCapabilitiesSchema } from "./provider-capabilities.ts";

// Credentials are a REFERENCE, never a raw secret. `subscription` = the user's
// logged-in Claude (claude-cli, no secret); `env` ref = an env-var name;
// `keychain` ref = a macOS Keychain service id; `none` = keyless (localhost
// Ollama/vLLM/LM Studio — the client sends no Authorization). Resolved lazily at
// launch in infra, never persisted to SQLite, never logged.
export const AuthRefSchema = z
  .object({
    kind: z.enum(["subscription", "env", "keychain", "none"]),
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
    // Declared per-provider quirks (wire dialect, reasoning round-trip, cache,
    // contextWindow). Omitted ⇒ defaulted per kind. Read by the in-process model
    // clients (capability-not-kind discipline); only contextWindow is consumed in M1.
    capabilities: ProviderCapabilitiesSchema.optional(),
    // Operator-defined power-tier vocabulary: an ORDERED list (strongest-first) of
    // {name, model} the spawn tier gate resolves against. Omitted ⇒ the code preset
    // (by origin) / CLAUDE_IDENTITY seed — zero config reproduces today's
    // high/medium/low. `.min(1)` rejects a zero-tier profile at load. NOT the effort
    // axis (that's the separate EFFORT_LEVELS enum).
    tiers: z
      .array(z.object({ name: z.string().min(1), model: z.string().min(1), hint: z.string().optional() }))
      .min(1)
      .optional(),
    // Which tier is the default when a spawn requests none. Omitted ⇒ tiers[0] (the
    // strongest). Lets a config pick a non-first default (e.g. keep opus default while
    // exposing a stronger max tier). Validated at spawn against the resolved vocabulary.
    defaultTier: z.string().min(1).optional(),
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
