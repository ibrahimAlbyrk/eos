# Backend hardcoding — root cause & clean/SOLID fix (BackendDescriptor)

**Status:** Design report (no implementation). **Date:** 2026-06-18.
**Trigger:** the codebase is littered with `kind === "claude-cli"` / `kind === "claude-sdk"` checks. Adding a provider means editing all of them; the same fact (e.g. "is subscription-billed") is duplicated in core *and* the UI. This report diagnoses why and specifies a data-driven, Open/Closed-clean fix.

---

## 1. Symptom — provider knowledge is hardcoded at every consumer

Every place that needs a provider *property* re-derives it from the `kind` string literal. Grouped by the property they're really asking for:

| Property the code wants | Hardcoded as | Sites (file:line) |
|---|---|---|
| **Is it in-process?** (handle kind, liveness, kill/interrupt routing) | `kind !== "claude-cli"` | `DispatchMessage.ts:92`, `dispatch-deps.ts:26`, `resume-helpers.ts:23`, `interrupt-worker.ts:20`, `KillWorker.ts` (the inproc else-branch) |
| **Is it subscription-billed?** (cost label, billing guard, creds fallback) | `SUBSCRIPTION_KINDS = {claude-cli, claude-sdk}` | `core/src/domain/backend-billing.ts:9`, **duplicated** in `app/ui/src/lib/backendCaps.js:17`, and `SqlBackedBackendResolver.ts:40` (`k === "claude-cli" || k === "claude-sdk"`) |
| **Does the worker model come from the request** (vs a profile-fixed model)? | `rb.kind !== "claude-cli" && rb.kind !== "claude-sdk"` | `spawn-worker.ts:66`, `orchestrators.ts:54` |
| **What are its UI capabilities?** (keystroke, runtime model switch) | `kind === "claude-cli" ? PTY : STRUCTURED` | `app/ui/src/lib/backendCaps.js:12` |
| **What is the default/global kind?** | `?? "claude-cli"` | `DispatchMessage.ts:91`, `SpawnWorker.ts:243`, `resume-helpers.ts:14`, `interrupt-worker.ts:18`, `SqliteWorkerRepo.ts:94`, `SqlBackedBackendResolver.ts:69` |
| **Which provider needs subscription creds → fall back to PTY?** | `rb.kind === "claude-sdk"` → `"claude-cli"` | `manager/shared/spawn-backend.ts:13,17` |
| **Which providers exist + their labels/models** (UI picker) | static `[{value:"claude-sdk",label:"Claude SDK"}, …]` | `app/ui/src/settings/registry.jsx:118-124` |

(Legitimate, *not* a smell: each adapter declaring **its own** `kind` — `ClaudeCliBackend.ts:59`, `ClaudeSdkBackend.ts:123`; the `BackendKind` enum `canonical.ts:16`; the registry registration `container.ts:615,622`. Those are identity/registration, exactly where a literal belongs.)

---

## 2. Root cause

**There is no single source of per-provider metadata.** A provider is currently represented by three thin things — a `BackendKind` enum string, an `AgentBackend` adapter (its `kind` + a `start`/`attach`), and a `BackendProfile` (config: kind+model+auth+costMode) — none of which carries the *behavioral facts* the rest of the system needs. So every consumer reconstructs those facts from the `kind` string.

Consequences, all textbook:

- **Open/Closed violation.** Adding a 5th provider (say `openai`) means hunting down and editing ~15 conditionals across `core/`, `manager/`, `infra/`, and `app/ui/`. The compiler can't tell you which sites you missed — they silently take the wrong (claude-cli) branch.
- **Duplication / drift.** "subscription-billed" is encoded *twice* (`core/.../backend-billing.ts` and `app/ui/.../backendCaps.js`) and again as an inline check in the resolver. A self-hosted `claude-sdk` profile with `costMode:"billed"` is already mislabeled by the UI because it keys on kind, not on the resolved `costMode`.
- **Two sources of truth for the same fact.** Billing is derived *both* from `kind` (the `SUBSCRIPTION_KINDS` sets) *and* from a profile's `costMode` field — and they can disagree.
- **The model list isn't provider-aware.** The UI's model picker is one global catalog (`MODELS`, from `applyCatalog(uiConfig.modelCatalog)` — the Claude `/v1/models`). It is *not* scoped to the selected provider, so an OpenAI/DeepSeek provider would offer Claude model names. The user's ask — "the selected provider's models should be used" — has no data behind it today.

In short: **the system branches on *identity* (`kind`) where it should branch on *properties* (data).**

---

## 3. The fix — a `BackendDescriptor` (provider metadata as data)

Give every backend kind ONE descriptor that declares its behavioral facts. Every `kind === X` check becomes a descriptor-property lookup. Adding a provider = register one descriptor (+ its adapter); zero scattered edits.

```ts
// contracts/src/backend.ts (or core/src/ports) — the single source of provider facts.
export interface BackendDescriptor {
  readonly kind: BackendKind;                       // identity (the ONLY place the literal lives)
  readonly label: string;                           // UI: "Claude SDK"
  readonly processModel: "in-process" | "out-of-process";  // → handle kind, liveness, kill/interrupt
  readonly billing: "subscription" | "metered";     // → cost label, billing guard, creds fallback
  readonly modelSource: "request" | "profile";      // request = composer's model; profile = fixed (metered API)
  readonly models: ModelCatalogRef;                 // which catalog the UI shows for this provider
  readonly capabilities: AgentCapabilities;         // keystroke / interrupt / runtimeModelSwitch / … (UI gates on THIS)
  readonly auth: "subscription" | "apikey" | "none";// what credential it needs (drives the creds-absent fallback)
  readonly enabled: boolean;                         // selectable now vs "soon" (no key configured, etc.)
}

// ModelCatalogRef: how to populate the per-provider model picker.
export type ModelCatalogRef =
  | { kind: "claude" }                  // the existing /v1/models Claude catalog (cli + sdk share it)
  | { kind: "static"; models: string[] }// explicit list (deepseek-reasoner, kimi-k2-thinking, …)
  | { kind: "openai-compatible" };      // fetch from the provider's /models endpoint (later)
```

Where it lives and who reads it:

- **The `AgentBackend` adapter exposes its descriptor** (`readonly descriptor: BackendDescriptor`), next to `kind`. `AgentCapabilities` (today only on the live `AgentSession`) is promoted into the descriptor — it was always static per kind. `AgentBackendRegistry` gains `descriptors(): BackendDescriptor[]`.
- **Core/manager consumers** read `backends.get(kind).descriptor.<property>` instead of comparing the string.
- **The UI** gets the descriptors over HTTP (extend `GET /api/ui-config`, or a `GET /api/providers`) and renders the provider dropdown + the per-provider model picker + capability gating entirely from that data.

### Every hardcoded check, rewritten as a lookup

| Today | Becomes |
|---|---|
| `kind !== "claude-cli"` (is-inproc) | `descriptor.processModel === "in-process"` |
| `kind === "claude-cli" ? {http} : {inproc}` | `descriptor.processModel === "out-of-process" ? {http,…} : {inproc,…}` |
| `SUBSCRIPTION_KINDS.has(kind)` (core + UI) | `descriptor.billing === "subscription"` |
| `rb.kind !== "claude-cli" && rb.kind !== "claude-sdk"` (model source) | `descriptor.modelSource === "profile"` |
| `backendCaps(kind)` (UI keystroke/model-switch) | `worker.capabilities` (the descriptor's, surfaced per worker) |
| `?? "claude-cli"` (default kind, ×6) | a single `config.defaults` / `defaultBackendKind` — never a literal |
| `rb.kind === "claude-sdk"` → fall back to `"claude-cli"` | `descriptor.auth === "subscription"` + a configured `fallbackKind` |

### The user's three asks, answered

1. **"kind/model shouldn't be hardcoded — they flow from the UI."** They already flow in (`backendKind` + the composer model). The fix removes the *branching* on specific kinds: the daemon never compares `kind` to a literal; it consults the descriptor.
2. **"the selected provider's models should be used."** The provider dropdown is the descriptor list (`label`/`enabled`); when you pick a provider, the model picker shows *that descriptor's* `models` catalog. (cli + sdk → the Claude catalog; a future openai provider → its own.) The composer sends `{backendKind, model}` and the server validates the model is in the provider's catalog.
3. **"kind shouldn't be fixed like this."** Providers become a *registry of descriptors*. The default kind is config. Adding/removing a provider is data + one adapter registration — the conditionals are gone, so nothing to forget to update.

---

## 4. Design patterns

- **Registry + Strategy** — `AgentBackendRegistry` already maps kind→adapter; extend it to carry descriptors. The descriptor *is* the strategy's declared metadata.
- **Open/Closed** — new provider = new descriptor (data) + adapter; existing code is closed to edits.
- **Capability Object** — `AgentCapabilities` consumed as data everywhere (UI included), never re-derived from kind. (Step D already started this server-side; this finishes it by surfacing it.)
- **Single Source of Truth / DRY** — billing, process model, model source, capabilities, default kind: each defined once, in the descriptor. Kills the core/UI `SUBSCRIPTION_KINDS` duplication and the kind-vs-costMode disagreement.
- **Anti-Corruption boundary preserved** — the only literals left are each adapter naming itself + the registry wiring, which is correct.

---

## 5. Migration plan (incremental, each step gated)

1. **Define `BackendDescriptor`** in `contracts/`; add `readonly descriptor` to `AgentBackend` (move the per-kind `AgentCapabilities` into it) + `registry.descriptors()`. Populate the four existing adapters (claude-cli, claude-sdk, anthropic-api, openai/codex). *No behavior change yet.*
2. **Replace the property checks, category by category** (each its own gated change, behavior-preserving):
   - process-model: `isInproc` + handle construction (`DispatchMessage`, `dispatch-deps`, `resume-helpers`, `interrupt-worker`, `KillWorker`).
   - billing: delete both `SUBSCRIPTION_KINDS` sets + the resolver inline check → `descriptor.billing`; reconcile `costMode` to *default from* the descriptor.
   - model-source: `spawn-worker`/`orchestrators` model branch → `descriptor.modelSource`.
   - default kind: the `?? "claude-cli"` sites → `config.defaults` / a `defaultBackendKind`.
   - creds-fallback: `spawn-backend.ts` → `descriptor.auth` + a configured fallback kind.
3. **Surface descriptors to the UI**: extend `ui-config` (or `GET /api/providers`); the provider dropdown + capability gates read it. Delete `app/ui/src/lib/backendCaps.js` (kind-keyed) — read `worker.capabilities` + the descriptor instead.
4. **Provider-aware models**: the model picker reads the selected provider's `descriptor.models` catalog; make the `ModelCatalog` port provider-keyed (Claude catalog for cli/sdk; static/openai-compatible for others). Validate `{backendKind, model}` on spawn.
5. **Conformance test**: assert no `kind === "<literal>"` comparisons remain outside adapters/registry (a lint rule or a grep test), so the Open/Closed property is enforced, not just achieved once.

**Risk:** low–medium and almost entirely mechanical (lookup-for-literal swaps), behavior-preserving per step, gated by the existing suites. The one design decision to confirm: billing as an inherent per-kind fact (descriptor) vs a per-profile `costMode` — recommendation: descriptor is the source of truth, `costMode` becomes a display default derived from it (a profile may not contradict its kind's billing).

---

## 6. Bottom line

The scattered `kind === "claude-cli"/"claude-sdk"` checks are the system **branching on provider identity instead of provider properties**, because no per-provider metadata object exists. A `BackendDescriptor` registry — one declarative record per kind, exposing process-model / billing / model-source / capabilities / models / auth — turns every check into a data lookup, removes the core↔UI duplication, makes the model picker provider-aware, and makes "add a provider" a registration rather than a cross-cutting edit. It is the natural completion of the same data-over-kind principle Steps D/F already started.
