// Model ↔ provider validation — pure domain rules for deciding whether a
// requested model may run on a given backend, read from the descriptor's model
// catalog (a CAPABILITY, never a kind literal). Two layers:
//   modelMatchesFamily — the provider-family predicate (Claude alias ⇒ claude
//                        catalog; a non-Claude id ⇒ an openai-compatible/static
//                        lane). Shared with the spawn-time override guard.
//   checkModelForProvider — the full descriptor check the runtime model switch
//                        gates on: reject only what's provably invalid.
// Provider stays immutable mid-session, so this only guards the MODEL value.

import type { BackendDescriptor, ModelCatalogRef } from "../ports/AgentBackend.ts";

// A Claude-family model identifier: the tier aliases (opus/sonnet/haiku/fable)
// optionally followed by a version suffix (e.g. "sonnet-5", "opus-4.8"), a
// concrete "claude-*" id, or an "anthropic/…" provider-routed id. The tier
// name must be followed by a non-alpha char or end-of-string so "haikumaster"
// etc. don't accidentally match. Anything else (deepseek-*, gpt-*, …) is false.
function isClaudeModelId(model: string): boolean {
  const m = model.toLowerCase();
  return /^(opus|sonnet|haiku|fable)([^a-z]|$)/.test(m)
    || m.startsWith("claude-") || m.startsWith("anthropic/");
}

// Does `model` plausibly belong to a provider whose catalog is `family`? The
// family is read from the descriptor's model catalog (models.kind) — a Claude
// alias lands only on a claude-catalog lane and a non-Claude id only on an
// openai-compatible/static lane. Unknown family (descriptor missing) fails open.
export function modelMatchesFamily(model: string, family: ModelCatalogRef["kind"] | undefined): boolean {
  if (!family) return true;
  return isClaudeModelId(model) === (family === "claude");
}

export type ModelProviderCheck = { ok: true } | { ok: false; reason: string };

// Validate a requested model against a backend descriptor's model catalog before
// a runtime switch persists it. Reject only what's PROVABLY invalid — the valid
// set of an openai-compatible endpoint isn't statically known, so only a
// cross-family id (a Claude alias on that lane) is refused; an unrecognised name
// passes. A "static" catalog carries an explicit list, so anything outside it is
// refused. A descriptor with no catalog fails open.
export function checkModelForProvider(descriptor: BackendDescriptor, model: string): ModelProviderCheck {
  const catalog = descriptor.models;
  if (!catalog) return { ok: true };
  if (catalog.kind === "static") {
    return catalog.models.includes(model)
      ? { ok: true }
      : { ok: false, reason: `model "${model}" is not offered by ${descriptor.label}` };
  }
  return modelMatchesFamily(model, catalog.kind)
    ? { ok: true }
    : { ok: false, reason: `model "${model}" is not valid for provider ${descriptor.label}` };
}
