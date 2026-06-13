// Select + order the fragments that make up a session's system prompt. Pure:
// (1) include fragments whose `when` passes (or have none); (2) drop any id a
// selected fragment `overrides` — a more-specific fragment supersedes a general
// one (a fragment can never override itself); (3) order by layer rank, then
// ascending priority, then id (stable + deterministic — golden tests depend on it).

import { PROMPT_LAYERS } from "../../../contracts/src/prompt.ts";
import type { PromptLayer, SessionFacts } from "../../../contracts/src/prompt.ts";
import type { Fragment } from "../domain/prompt.ts";
import { evaluateCondition } from "./condition-eval.ts";

// Rank derived from the canonical layer order — single source, no desync.
const LAYER_RANK = Object.fromEntries(PROMPT_LAYERS.map((layer, i) => [layer, i])) as Record<PromptLayer, number>;

export function selectFragments(fragments: Fragment[], facts: SessionFacts): Fragment[] {
  const included = fragments.filter((f) => !f.dpi.when || evaluateCondition(f.dpi.when, facts));

  const dropped = new Set<string>();
  for (const f of included) {
    for (const id of f.dpi.overrides ?? []) {
      if (id !== f.prompt.id) dropped.add(id); // a fragment can't override itself
    }
  }
  const surviving = included.filter((f) => !dropped.has(f.prompt.id));

  return surviving.sort((a, b) => {
    const byLayer = LAYER_RANK[a.dpi.layer] - LAYER_RANK[b.dpi.layer];
    if (byLayer !== 0) return byLayer;
    if (a.dpi.priority !== b.dpi.priority) return a.dpi.priority - b.dpi.priority;
    return a.prompt.id < b.prompt.id ? -1 : a.prompt.id > b.prompt.id ? 1 : 0;
  });
}
