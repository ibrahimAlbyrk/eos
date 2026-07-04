// Render the provider-specific model + effort guidance the DPI prompt interpolates.
// A worker's model-picker table (MODEL_TIER_TABLE) shows its OWN provider's concrete
// model per tier; the effort section (EFFORT_SECTION) is the full effort table when
// the provider has a reasoning-effort lever, or a one-liner telling the model to omit
// effort when it does not. Kept out of core (a manager render helper) — core carries
// only the ProviderIdentity data.

import { isClaudeIdentity, type ProviderIdentity } from "../../core/src/domain/model-tier.ts";

// | tier | model | use for | — preserves the 09-model.prompt.md guidance semantics.
export function renderModelTierTable(identity: ProviderIdentity): string {
  const t = identity.tiers;
  return [
    "| tier | model | use for |",
    "|---|---|---|",
    `| high | ${t.high} | ambiguous problems, multi-file design, debugging |`,
    `| medium | ${t.medium} | well-specified refactors, straightforward tests, mechanical edits |`,
    `| low | ${t.low} | trivial edits, summaries, greps — fastest |`,
  ].join("\n");
}

const EFFORT_TABLE = [
  "| effort | use for |",
  "|---|---|",
  "| low | trivial mechanical edits, summaries, fixed-format output |",
  "| medium | routine, well-specified work |",
  "| high | substantial but straightforward implementation |",
  "| xhigh (default) | complex debugging, design, anything where wrong output is hard to recover from |",
  "| max | correctness-critical work — the strongest reasoning, when a wrong answer is unacceptable |",
].join("\n");

const NO_EFFORT_LINE = "This provider exposes no reasoning-effort lever — omit effort.";

export function renderEffortSection(identity: ProviderIdentity): string {
  return identity.effortSupported ? EFFORT_TABLE : NO_EFFORT_LINE;
}

// The default effort to spawn with: xhigh matches Claude's own default tier; other
// effort-capable providers default to high.
export function defaultEffortFor(identity: ProviderIdentity): string {
  return isClaudeIdentity(identity) ? "xhigh" : "high";
}
