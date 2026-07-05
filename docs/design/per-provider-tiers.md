# Per-provider variable-length tier vocabularies

Design-only. No code changes in this document — it is the spec an implementer
follows. Every recommendation is grounded in a concrete file:line read.

## Goal

Today every provider exposes exactly three model tiers — `high | medium | low` —
baked into a TS literal union and a 3-key struct. We want each provider to define
its OWN ordered tier vocabulary of arbitrary length and naming: one provider may
expose `[low, medium]`, another `[low, medium, high, max]`, another
`[low, medium, high, max, ultra]`. The operator defines these (config-driven).
When a provider is the active backend, the orchestrator's system prompt must
inject THAT provider's tier table (today a static 3-row table is always injected),
and a spawn requesting a tier the active provider does not define must be rejected
cleanly rather than passed through to the API as a bogus model id.

## Current state (verified)

- Tier type + struct: `ModelTier = "high"|"medium"|"low"` and
  `interface TierMap { high; medium; low }` at
  `core/src/domain/model-tier.ts:10-16`. `ProviderIdentity.tiers: TierMap` at
  `model-tier.ts:18-26`.
- Resolver: `resolveTier(model, identity)` at `model-tier.ts:59-68` — a literal
  `if (model === "high" || "medium" || "low")` returns `identity.tiers[model]`;
  else a legacy Claude alias via `ALIAS_TIER_FALLBACK`
  (`model-tier.ts:40-45`: opus/sonnet/haiku/fable → high/medium/low, non-Claude
  only); else passthrough as a concrete id. `CLAUDE_IDENTITY.tiers`
  (high=opus/medium=sonnet/low=haiku) at `model-tier.ts:31-35`.
- Identity resolution: `resolveProviderIdentity(descriptor, profile)` at
  `manager/shared/provider-identity.ts:24-49` — claude-family catalog
  (`descriptor.models.kind === "claude"`) → `CLAUDE_IDENTITY`; else a preset
  matched by ORIGIN (`findPresetByOrigin(profile.baseUrl)`) → the preset's tiers;
  else collapse all three tiers to the pinned model
  (`provider-identity.ts:41-48`).
- Presets: 7 OpenAI-compatible presets each carry `tiers: TierMap` in
  `manager/shared/provider-presets.ts` (e.g. openai `presets.ts:57`, deepseek
  `presets.ts:163`). `ProviderPreset.tiers` declared at `presets.ts:33`.
- Spawn chokepoints that call `resolveTier`:
  - `manager/container.ts:755` — DPI prompt assembly, `resolveTier(spec.model ?? "high", identity)`.
  - `manager/routes/orchestrators.ts:68-71` — orchestrator spawn, `resolveTier(... split.model ?? "high" ...)`.
  - `manager/shared/spawn-backend.ts:79` — the ONE-WAY tier gate; also seeds a
    bare-kind default `model: "high"` at `spawn-backend.ts:37` and `:68`.
  - `manager/commands/handlers/spawn-worker.ts:145` — worker spawn tier gate,
    beside the family guard at `spawn-worker.ts:151-166`.
- Prompt table is already dynamic: `renderModelTierTable(identity)` at
  `manager/shared/tier-prompt-render.ts:11-20` fills `{{MODEL_TIER_TABLE}}` in
  `manager/prompts/role/orchestrator/09-model.prompt.md:18`, threaded via
  `AssembleSystemPrompt.ts` (`modelTierTable` var, `AssembleSystemPrompt.ts:127`)
  and populated at `container.ts:770`.
- Validation gap: `model` is `z.string()` in both tool defs
  (`spawn_worker.ts:18`, `create_worker.ts:12`) and in the definition schema
  (`contracts/src/worker-definition.ts:22`). No enum, no gateway-level tier
  rejection. Tool descriptions hardcode the `'high' | 'medium' | 'low'` string
  (`spawn_worker.ts:19`, `create_worker.ts:12`), snapshotted in
  `manager/tools/__tests__/registration.snapshot.json`.
- Config shape: `config.backends: Record<string, BackendProfile>`
  (`manager/shared/config.ts:96`); `BackendProfileSchema` at
  `contracts/src/backend.ts:27-43` has kind/model/baseUrl/auth/pricing/costMode/
  params/capabilities — **no `tiers` field**. Profiles merge atomically per-name
  (`config.ts:626-629`). Presets are NOT in `DEFAULT_BACKENDS`
  (`config.ts:301-313`, claude only); a preset becomes a profile via
  `POST /api/backends`, and tiers are resolved by origin at spawn time, not stored.

### Effort is a SEPARATE axis (confirmed)

`EFFORT_LEVELS = ["low","medium","high","xhigh","max"]` is an independent 5-value
Zod enum at `contracts/src/shared.ts:8`, gated per provider by
`ProviderIdentity.effortSupported` (`model-tier.ts:25`) and rendered by
`renderEffortSection` (`tier-prompt-render.ts:34-36`). A spawn passes BOTH
`model` (tier) and `effort` (`spawn_worker.ts:18,21`). Tiers and effort share the
substrings `low/medium/high` but are orthogonal — **this design must not entangle
them**: no reuse of `EFFORT_LEVELS` for tiers, no change to the effort enum or
`effortSupported`. The naming overlap is a documentation hazard only (see Risk 3).

---

## Decision 1 — Data model: ordered array of `{ name, model }`

**Recommendation:** replace `TierMap` with an ordered array of tier specs, stored
**strongest-first**, where `tiers[0]` is by invariant the provider's default tier.

```
// core/src/domain/model-tier.ts (shape only — design)
export interface TierSpec {
  name: string;    // provider-defined tier label, e.g. "high", "max", "ultra"
  model: string;   // concrete model id this tier resolves to
  hint?: string;   // optional "use for" text; falls back to rank-derived guidance
}
export interface ProviderIdentity {
  persona: string;
  tiers: TierSpec[];        // ordered strongest→weakest, length ≥ 1
  effortSupported: boolean;
}
```

**Why an array over the alternatives:**

- `Record<string,string>` (name→model): loses order, and ranking IS the point —
  the prompt says "fit DOWN when the task allows" (`09-model.prompt.md:16`) and
  the default is the strongest tier. Relying on JS object key order for a ranked
  semantic is fragile and reads as accidental. It also can't carry a per-tier
  hint without nesting.
- Named fields `{high, medium, low}` (today): fixed length by construction — the
  exact thing we're removing. Fails OCP: adding "max"/"ultra" edits the type.
- **Ordered array**: order = ranking (explicit, JSON-stable, survives config
  round-trip), variable length is native, and the `tiers[0] = default` invariant
  removes any need for a separate `defaultTier` field. Name→model is an O(n) find
  with n ≤ ~6 — negligible. Optional `hint` rides each entry cleanly. This is the
  clean-architecture / OCP fit: adding a tier is data, never a type edit.

**Order direction:** strongest-first (descending capability). Justification: it
makes "the default tier is `tiers[0]`" a pure structural invariant (no marker
field), it matches the existing render order (high, medium, low top-down at
`tier-prompt-render.ts:16-18`), and it matches how an operator authors a config
("flagship first"). The word "ranked low→high" in the requirement describes that
tiers ARE ranked, not a storage direction; the array is self-describing either
way. If ascending authoring is ever preferred, the alternative is an ascending
array + an explicit `defaultTier?: name` field — recommend against it (the extra
field is a second source of truth for "which is default").

**Effort stays untouched** — see the confirmation above. `effortSupported`
remains a boolean; `EFFORT_LEVELS` is not involved.

---

## Decision 2 — Where tiers live: config-first, code-seeded (hybrid)

**Recommendation:** make tiers an optional field on the config `BackendProfile`,
with the built-in code presets + `CLAUDE_IDENTITY` as the seed/fallback.

Resolution precedence in `resolveProviderIdentity`:

1. `profile.tiers` (config, operator-defined) — **wins when present**, for any
   family. This is the "we define them" path.
2. else preset tiers matched by origin (`findPresetByOrigin`,
   `provider-identity.ts:33`) — the 7 shipped providers keep working with zero
   config.
3. else claude-family (`descriptor.models.kind === "claude"`) → `CLAUDE_IDENTITY`.
4. else collapse to the pinned model, as a canonical-baseline triple (see below).

**Why this fits the real config schema.** `config.backends` is
`Record<string, BackendProfile>` (`config.ts:96`) and a profile merges
atomically per name (`config.ts:626-629`) — so adding an optional `tiers` array
to `BackendProfileSchema` (`contracts/src/backend.ts:27`) needs **no special
merge logic**; a profile either carries its full tier list or it doesn't.
`DaemonConfigOverrideSchema.backends` (`config.ts:521`) already validates profiles
through the same `BackendProfileSchema`, so config-load validation (min-length,
shape) comes for free — including "provider defines zero tiers" being rejected at
load (Risk 2).

**Back-compat with the by-origin preset resolution.** Today a preset's tiers are
resolved by matching `profile.baseUrl` to a preset origin — the profile itself
carries no tiers. Making tiers config-first is purely additive: a stored profile
with no `tiers` field resolves exactly as today (step 2/3/4). When
`POST /api/backends` creates a profile from a preset, it MAY bake the preset's
tiers into the stored profile so they surface in `config.json` for editing — but
that is an enhancement, not a requirement; resolution already falls back to the
by-origin preset. Recommend baking them in on create for discoverability, keeping
the by-origin fallback for existing installs.

**Claude caveat.** Claude is request-model — its tiers ARE the aliases the
composer picks (`model-tier.ts:28-35`). Allowing `profile.tiers` to override even
claude-family is symmetric and harmless as long as the operator supplies valid
Claude aliases/ids; document that overriding a Claude profile's tiers with
non-alias ids can mis-drive the request-model lane (Risk 8). Default (no
override) stays `CLAUDE_IDENTITY`.

---

## Decision 3 — Resolver + validation

### `resolveTier` becomes vocabulary-aware (pure, core)

New behavior (`core/src/domain/model-tier.ts:59`):

1. If `model` matches a `tiers[i].name` → return `tiers[i].model` (replaces the
   hardcoded `model === "high"|"medium"|"low"` check at `model-tier.ts:60`).
2. Else if `model` is a legacy Claude alias (`ALIAS_TIER_FALLBACK`) and the
   identity is non-Claude → resolve the alias's canonical baseline name
   (opus→high, sonnet→medium, haiku→low, fable→high) against the vocabulary; if
   that exact name is absent, **clamp to the nearest defined rank** (Risk 6).
3. Else passthrough (a concrete id, or `provider/model` sugar handled upstream).

Add pure helpers in the same file: `tierNames(identity): string[]`,
`defaultTierName(identity): string` (= `tiers[0].name`), and
`hasTier(identity, name): boolean`. These stay Node-free in core.

### Where validation belongs: spawn-time rejection at the chokepoint

The active provider (and thus the vocabulary) is known only at spawn time, not at
schema-parse time — a static Zod enum on `model` cannot enumerate a dynamic,
per-provider vocabulary. So:

- **Keep `model` as `z.string()`** in the tool/definition schemas
  (`spawn_worker.ts:18`, `create_worker.ts:12`,
  `contracts/src/worker-definition.ts:22`). Zod cannot know the vocabulary.
- **Reject at the spawn chokepoint**, reusing the existing family guard. The
  worker path already fails loud on a cross-family concrete model at
  `spawn-worker.ts:151-166`. Extend that same point: after computing `identity`,
  classify the requested string —
  - a defined tier name (`hasTier`) → resolve;
  - a legacy alias → resolve/clamp;
  - a concrete id matching the provider family (`modelMatchesFamily`,
    `core/src/domain/model-provider.ts:28`) → passthrough;
  - **none of the above → `ValidationError`** naming the valid tiers
    (`tierNames(identity)`).

  This closes the `z.string()` passthrough gotcha (Risk 1): today a bogus tier
  like `"ultra"` on a provider without it silently becomes the concrete model id
  `"ultra"` and 400s at the API.

**Why not throw inside `resolveTier`.** `resolveTier` cannot distinguish a
typo'd tier from a legitimate concrete id — both are "not in the vocabulary" —
and it is a pure resolver used on paths where a concrete id is expected. Keep it
total (never throws); put the reject at the entrypoint where the family signal
(`modelMatchesFamily`) disambiguates "unknown tier" from "concrete id". Core
stays pure (resolution + predicates); manager owns policy (rejection). This is
the existing division of labor at `spawn-worker.ts`.

---

## Decision 4 — Prompt injection: variable-length table

`renderModelTierTable(identity)` (`tier-prompt-render.ts:11`) currently emits
exactly 3 rows with per-name "use for" text. Generalize:

- Iterate `identity.tiers` in order, one `| name | model | use-for |` row each.
- "use for" text: prefer `tier.hint` when the operator supplied one; else derive
  from rank position — top rank → "ambiguous problems, multi-file design,
  debugging"; bottom rank → "trivial edits, summaries, greps — fastest";
  interior ranks → "well-specified refactors, straightforward work". This keeps
  the current semantics for the 3-tier case while scaling to N tiers without
  hardcoding names.

Orchestrator prompt guidance that assumes exactly 3 tiers /
a tier literally named "high":

- `09-model.prompt.md:16` — "Default is the **high** tier" hardcodes the tier
  name. A provider's strongest tier may not be named "high". Replace with a
  `{{DEFAULT_TIER}}` variable and add it to the fragment's `variables:` front
  matter (`09-model.prompt.md:3-7`). The rest of the prose ("fit DOWN when the
  task allows", `09-model.prompt.md:16`) is rank-relative and stays valid.
- `16-available-workers.prompt.md:108` uses `model: "high"` in an EXAMPLE
  create_worker snippet — an illustrative default, not a hardcoded 3-tier table;
  leave it (or note it renders as the baseline). The "high/medium/low" mentions
  in `14-swarm-playbook.prompt.md` and `15-peer-collaboration.prompt.md` are
  RESEARCH-CONFIDENCE tiering ("confirmed across ≥2 → high"), unrelated to model
  tiers — **do not touch**.

Plumb `DEFAULT_TIER`: add `defaultTier?: string` to `SessionSpawnContext`
(`AssembleSystemPrompt.ts:21-54`) and a `DEFAULT_TIER` entry to `sessionVars`
(`AssembleSystemPrompt.ts:111-132`), populated at `container.ts:770` from
`defaultTierName(identity)`.

---

## Decision 5 — Back-compat + migration

**Compatibility contract:**

- **`low < medium < high` is the canonical ranked baseline.** Every built-in
  provider (Claude + all 7 presets) defines these three names, unchanged. Legacy
  worker definitions and prompts that reference `model: "high"|"medium"|"low"`
  keep resolving because those names remain defined for the default providers.
- **Tier names are free-form**, not drawn from an enforced superset. Rationale:
  the code never compares ranks ACROSS providers — a worker interprets its tier
  against the single resolved active provider (a pinned `backendProfile` swaps the
  vocabulary; §Decision 3 validates per-spec). So a global ranked superset buys no
  correctness and adds schema/validation burden. Providers MAY add stronger tiers
  ("max", "ultra") or expose fewer ("only low/medium"). Recommend, as convention
  (not enforced), that operators keep the baseline names for the common tiers so
  legacy defs and the Claude-alias fallback resolve cleanly.
- **Zero-config migration.** Absent `profile.tiers` → today's behavior exactly
  (preset by origin / `CLAUDE_IDENTITY` / collapse). No data migration, no config
  rewrite required. The change is purely additive.
- **Collapse fallback keeps the baseline triple.** The unknown-provider collapse
  (`provider-identity.ts:41-48`) today fills all three of high/medium/low with the
  pinned model so any legacy tier request resolves. Preserve that: collapse →
  `[{name:"high"},{name:"medium"},{name:"low"}]` all pointing at the pinned model
  (strongest-first, so `tiers[0]`="high" stays the default). This keeps
  `resolveTier("high"|"medium"|"low", collapsed)` working as today.

---

## Decision 6 — Layer-ordered change set (contracts → core → manager → prompts → tests)

Dependency direction is `contracts → core → infra → entrypoints` (lint-enforced).
Tiers touch contracts (the profile shape), core (the pure domain + resolver), and
manager (identity resolution, rendering, spawn chokepoints, tool defs, prompts).
**No infra changes** — `provider-identity.ts`/`provider-presets.ts` live in
`manager/shared`, not `infra`.

### contracts/
- `contracts/src/backend.ts:27` — add optional `tiers` to `BackendProfileSchema`:
  `tiers: z.array(z.object({ name: z.string().min(1), model: z.string().min(1), hint: z.string().optional() })).min(1).optional()`.
  This is the config-driven source of truth; `.min(1)` makes zero-tier configs
  fail at load. **Do NOT touch** `EFFORT_LEVELS`/`EffortSchema`
  (`contracts/src/shared.ts:8`) — effort is a separate axis.

### core/ (pure domain)
- `core/src/domain/model-tier.ts`:
  - Replace `TierMap` (`:12-16`) with `TierSpec` + `tiers: TierSpec[]` on
    `ProviderIdentity` (`:18-26`).
  - Rewrite `CLAUDE_IDENTITY.tiers` (`:31-35`) as a strongest-first array
    `[{name:"high",model:"opus"},{name:"medium",model:"sonnet"},{name:"low",model:"haiku"}]`
    — behavior identical.
  - `ModelTier` union (`:10`): demote — it's used only as the VALUE type of
    `ALIAS_TIER_FALLBACK` (`:40`); those values become plain baseline-name
    strings. Remove the exported literal type (or keep as a doc alias).
  - Rewrite `resolveTier` (`:59-68`) per §Decision 3; add `tierNames`,
    `defaultTierName`, `hasTier` helpers (pure).
- `core/src/use-cases/AssembleSystemPrompt.ts` — add `defaultTier?: string` to
  `SessionSpawnContext` (`:21-54`) and a `DEFAULT_TIER` var in `sessionVars`
  (`:111-132`).

### manager/ (shared + entrypoints)
- `manager/shared/provider-presets.ts` — `ProviderPreset.tiers` (`:33`) → array
  type; rewrite all 7 presets' tiers to strongest-first arrays (same models):
  openai `:57`, gemini `:77`, xai `:92`, qwen `:109`, moonshot `:124`, zhipu
  `:142`, deepseek `:163`.
- `manager/shared/provider-identity.ts:24` — `resolveProviderIdentity`:
  precedence `profile.tiers` → preset → claude → collapse (§Decision 2);
  collapse builds the baseline triple (§Decision 5).
- `manager/shared/tier-prompt-render.ts:11` — `renderModelTierTable` iterates the
  vocabulary (§Decision 4). `renderEffortSection`/`defaultEffortFor` (`:34-42`)
  unchanged (effort axis).
- `manager/container.ts:755` — `spec.model ?? "high"` → `spec.model ?? defaultTierName(identity)`;
  add `defaultTier: defaultTierName(identity)` to the assemble context near `:770`.
- `manager/routes/orchestrators.ts:68-71` — `split.model ?? "high"` →
  `?? defaultTierName(identity)` (identity is `rb.providerIdentity ?? CLAUDE_IDENTITY`).
- `manager/shared/spawn-backend.ts:37,68` — the bare-kind / PTY-fallback seed
  `model: "high"` runs BEFORE identity is known (identity computed at `:78`).
  Reorder: seed with a sentinel/leave unset, then at `:79` resolve
  `resolveTier(rb.model ?? defaultTierName(identity), identity)`. A provider
  without a "high" tier otherwise breaks here.
- `manager/commands/handlers/spawn-worker.ts:145` — add the tier-validation reject
  (§Decision 3) alongside the existing family guard at `:151-166`.
- `manager/tools/defs/spawn_worker.ts:19` and `create_worker.ts:12` — replace the
  hardcoded `'high' | 'medium' | 'low'` description with "a power tier defined by
  the active provider (shown in your §Model table) or a concrete model id".
- `manager/tools/__tests__/registration.snapshot.json` — regenerate for the new
  descriptions.

### prompts/
- `manager/prompts/role/orchestrator/09-model.prompt.md:16` — "the **high** tier"
  → "the **{{DEFAULT_TIER}}** tier"; add `DEFAULT_TIER` to `variables:` (`:3-7`).

### tests (update expectations, add coverage)
- `core/src/__tests__/model-tier.test.ts` — array fixtures; add variable-length
  vocab, unknown-tier classification, and alias-clamp cases.
- `manager/shared/__tests__/tier-prompt-render.test.ts` — array fixtures; assert a
  2-tier and a 5-tier table render (drops the "exactly 3 rows" assumption).
- `manager/shared/__tests__/provider-identity.test.ts` — array assertions; add a
  `profile.tiers`-override case (config wins over preset).
- `manager/shared/__tests__/provider-presets.test.ts` — array tier shape.
- New: config `profile.tiers` round-trip (load → identity); spawn-time rejection
  of an undefined tier.

### Clean-architecture / capability-guard check
- `tiers` config field lives in contracts (single source of truth) ✓.
- Pure resolution + predicates in core, Node-free ✓; rendering + rejection in
  manager ✓; no new infra coupling ✓.
- **No branch on backend `kind`.** Resolution keys on `descriptor.models.kind`
  (a model-CATALOG family read, already used at `provider-identity.ts:30`) and the
  config profile/preset origin — never a lane literal. The
  `backend-kind-literal-guard` forbids `=== "claude-cli"`/`"claude-sdk"` style
  comparisons; the family check `descriptor.models.kind === "claude"` is catalog
  data and is allowed (and pre-existing). Do not introduce any lane-kind literal.

---

## Decision 7 — Risks & edge cases

1. **`z.string()` passthrough (primary gotcha).** Today an undefined tier silently
   becomes a concrete model id → API 400. Closed by the spawn-time reject
   (§Decision 3) at `spawn-worker.ts` beside the existing family guard.
2. **Provider defines zero tiers.** `.min(1)` on the config `tiers` array rejects
   it at config-load (`config.ts:691` safeParse path); the collapse fallback
   always yields ≥1. So the runtime invariant "length ≥ 1 / `tiers[0]` exists"
   holds.
3. **Tier vs effort name collision.** Both use `low/medium/high` substrings but
   are orthogonal axes (tiers = which model; effort = reasoning depth, the 5-value
   `EFFORT_LEVELS`). A spawn passes both. Do not merge the enums; a one-line
   comment at the `TierSpec`/`resolveTier` site should call out the distinction to
   prevent a future reader from wiring effort into tier resolution.
4. **Effort-vs-tier confusion downstream.** `effortSupported` and
   `renderEffortSection` stay exactly as-is; this design does not read or write
   effort. Verified independent.
5. **Hardcoded default tier `"high"` in four places** (`container.ts:755`,
   `orchestrators.ts:69`, `spawn-backend.ts:37`, `:68`) plus the prompt prose
   (`09-model.prompt.md:16`). A provider whose strongest tier isn't named "high"
   breaks until all become `defaultTierName(identity)` / `{{DEFAULT_TIER}}`.
   Highest-priority edge — easy to miss because "high" reads like a safe default.
6. **Legacy alias fallback on a sparse provider.** `ALIAS_TIER_FALLBACK` targets
   baseline names a `[low, medium]`-only provider may not define — clamp the
   alias to the nearest defined rank (e.g. sonnet→"high" clamps to "medium" when
   "high" is absent) rather than passing an undefined name.
7. **Tests asserting the fixed 3-tier shape** — enumerated in the change set:
   `model-tier.test.ts`, `tier-prompt-render.test.ts`, `provider-identity.test.ts`,
   `provider-presets.test.ts`, and the `registration.snapshot.json` tool-desc
   strings.
8. **Claude request-model semantics.** Claude tiers ARE the aliases the composer
   selects (`model-tier.ts:28`). If an operator overrides a Claude profile's
   `tiers` with non-alias ids, the request-model lane may mis-send. Allow the
   override (symmetry) but document the constraint; default stays `CLAUDE_IDENTITY`.
9. **Per-spec vocabulary on pinned workers.** A worker inherits the parent's
   backend/identity unless it pins `backendProfile`, which swaps the vocabulary.
   Identity is computed per-spawn-spec (`container.ts:781 identityForSpec`,
   `spawn-backend.ts:86 identityFor`), so tier validation is naturally per-spec —
   the spawn-time reject (§Decision 3) already runs against the correct provider.

---

## Summary

- **Data model:** ordered `TierSpec[]` (`{name, model, hint?}`), strongest-first,
  `tiers[0]` = default tier — replaces the fixed `TierMap`.
- **Where defined:** config-first — optional `tiers` on `BackendProfile`
  (contracts), with code presets + `CLAUDE_IDENTITY` as the fallback seed; zero
  config = today's behavior.
- **Validation:** `model` stays `z.string()` (vocabulary is dynamic); reject an
  undefined tier at the spawn chokepoint, reusing the `modelMatchesFamily` guard;
  `resolveTier` stays pure/total.
- **Prompt:** `renderModelTierTable` iterates the vocabulary (N rows); a
  `{{DEFAULT_TIER}}` variable replaces the hardcoded "high" in
  `09-model.prompt.md`.
- **Compat:** `low/medium/high` is the canonical baseline every built-in provider
  keeps; names are free-form; migration is additive-only.
