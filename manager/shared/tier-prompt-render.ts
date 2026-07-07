// Render the provider-specific model + effort guidance the DPI prompt interpolates.
// A worker's model-picker table (MODEL_TIER_TABLE) shows its OWN provider's concrete
// model per tier; the effort section (EFFORT_SECTION) is the full effort table when
// the provider has a reasoning-effort lever, or a one-liner telling the model to omit
// effort when it does not. Kept out of core (a manager render helper) — core carries
// only the ProviderIdentity data.

import { defaultTierName, isClaudeIdentity, type ProviderIdentity } from "../../core/src/domain/model-tier.ts";

// The rank-derived "use for" guidance when a tier carries no operator hint: top
// rank → hardest work, bottom rank → trivial/fastest, interior ranks → the middle.
function useForByRank(rank: number, count: number): string {
  if (rank === 0) return "ambiguous problems, multi-file design, debugging";
  if (rank === count - 1) return "trivial edits, summaries, greps — fastest";
  return "well-specified refactors, straightforward tests, mechanical edits";
}

// | tier | model | use for | — one row per tier in the provider's vocabulary,
// strongest-first. Preserves the 09-model.prompt.md guidance semantics for the
// 3-tier baseline while scaling to N tiers (operator `hint` wins over rank text).
// The default tier's row is marked "(default)" — since the default is no longer
// guaranteed to be the first row (defaultTier can decouple it from tiers[0]).
export function renderModelTierTable(identity: ProviderIdentity): string {
  const count = identity.tiers.length;
  const def = defaultTierName(identity);
  const rows = identity.tiers.map((t, i) => {
    const label = t.name === def ? `${t.name} (default)` : t.name;
    return `| ${label} | ${t.model} | ${t.hint ?? useForByRank(i, count)} |`;
  });
  return ["| tier | model | use for |", "|---|---|---|", ...rows].join("\n");
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
