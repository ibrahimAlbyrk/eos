# Dimension 04 — Config, Model-Selection & DPI

How a model + provider is *assigned* to the orchestrator and to every worker scope, how that
selection *flows* to the adapter, how credentials *resolve*, and how the per-spawn system prompt
(DPI) is *assembled* — measured against the user goal: "enter an API key or localhost URL, assign
ANY model (GLM-5.2, DeepSeek V3, a local model) to the orchestrator and every worker, all
interoperating." Cites are `file:line` against branch `feat/multi-provider-api`.

Sibling reconciliation (read at write time):
- **01-backend-abstraction.md** found per-profile `baseUrl`/`auth`/`params` are DROPPED before the
  adapter (only `model`+`profileName` thread; the factory reads global `process.env`). I OWN the fix
  design (§4). I **confirm and sharpen** that finding, and **correct one detail**: `ResolvedBackend`
  has *no `auth` field at all* — the profile's `AuthRef` is dropped at the very first hop
  (`container.ts:278`), earlier than dim 01 implies.
- **06-external-providers.md** recommends "a new provider = a `BackendProfile`, no new class" + a
  two-dialect (Anthropic Messages / OpenAI Chat) model. My design (§4) is built on exactly that:
  the whole multi-provider UX collapses to **profile-centric model selection** on `modelSource:"profile"`
  lanes, and `BackendProfile.params` is where 06's typed `ProviderCapabilities` lands.

---

## 1. Summary — what this dimension covers + load-bearing facts

This dimension is the *assignment + selection* layer: config (`BackendProfile` registry, per-role
defaults, prices), the model ports (`ModelCatalog`/`ModelCapabilities`/`ModelClient`/`ModelCatalogRef`),
credential resolution (`AuthResolver`), worker-definition model/backend declaration across the four
scopes, the orchestrator's own assignment path, and DPI prompt assembly + its immutable-`when` rule.

Five load-bearing facts (expanded + cited in §2/§3):

1. **Model-string and provider are DECOUPLED axes, and only the string is freely assignable today.**
   `setWorkerModel` persists `model`+`effort` and live-applies them when `runtimeModelSwitch` is true
   (`core/src/use-cases/SetWorkerModel.ts:54,57-66`) — it never changes backend kind / profile / baseUrl
   / auth. The composer/`PUT /workers/:id/model` can put any *string* on a worker, but it stays on the
   *same provider*. Assigning "GLM-5.2 over my localhost key" to a worker is **not expressible** per-worker.

2. **The config schema ALREADY models a multi-provider profile — the data just never reaches the client.**
   `BackendProfile` (`contracts/src/backend.ts:25-37`) carries `kind`, `model`, `baseUrl?`, `auth?`
   (an `AuthRef` reference, never a raw secret), `pricing?`, `costMode?`, `params?`. Profiles live in
   `config.backends: Record<name, BackendProfile>` (`manager/shared/config.ts:33-151`). The resolver
   materializes most of it (`SqlBackedBackendResolver.resolveForNewWorker`,
   `core/src/services/SqlBackedBackendResolver.ts:35-65`). But `ResolvedBackend`
   (`core/src/ports/BackendDefaults.ts:8-16`) **has no `auth` field**, and the spawn handler threads only
   `model`+`profileName` onto the spec (`manager/commands/handlers/spawn-worker.ts:122-123`); the
   in-process factories then read **global `process.env`** (`manager/container.ts:758-776`) and never call
   `authResolver`. So baseUrl/auth/params are global, not per-worker.

3. **A worker DEFINITION cannot pin a provider — only a bare `model` string + bare `backendKind`.**
   `WorkerDefinitionSchema` (`contracts/src/worker-definition.ts:11-44`) has `model?`, `backendKind?`,
   but **no `backendProfile` field**. Built-in/project/user/runtime defs all share this shape
   (`manager/container.ts:556-569`). The profile NAME only attaches at spawn time, set by the resolver
   on the worker row (`spawn-worker.ts:123`). So no worker *scope* can declare "run on the glm-local
   profile" — the key gap for "assign any model to every built-in/project/user worker."

4. **The orchestrator CAN already be assigned a provider — via config role default or explicit kind.**
   `POST /orchestrators` (`manager/routes/orchestrators.ts:23-66`) runs `spawnWorker` with
   `isOrchestrator:true`, resolving its backend through the same `resolveSpawnBackend({explicitKind,
   isOrchestrator:true})`, which falls to `config.defaults.orchestrator.backend`
   (`manager/container.ts:280-281`, default `"claude-sdk-opus"` at `manager/shared/config.ts:272-275`).
   For a `modelSource:"profile"` lane the orchestrator's model comes from the profile
   (`orchestrators.ts:~52`). The orchestrator path is therefore the *least* gapped — it's blocked by the
   same threading + enablement gaps as workers, not by a missing assignment mechanism.

5. **DPI is structurally safe for multi-provider, and must STAY model-agnostic in its gates.**
   `assembleSystemPrompt` (`core/src/use-cases/AssembleSystemPrompt.ts:58-78`) runs once per spawn.
   `SessionFacts` (`contracts/src/prompt.ts:88-109`) carries `model`/`effort` as *render variables* but
   **has no `backend`/`provider` field**, and the rule (CLAUDE.md:51) forbids a fragment `when` from
   gating on mutable facts (model/effort/backend) — enforced by discipline, **no test**. Provider choice
   must drive prompt content (if at all) through the assembly *lane parameter*
   (`assembleAppendFor(spec, id, "claude-cli")`), never through `when`.

Net: the user goal is **~1 enabler away on plumbing** plus **two small schema additions**. The config
*model* already exists; what's missing is (a) threading the profile's `auth`/`baseUrl`/`params` to the
in-process model client per-worker, (b) a `backendProfile` field on worker definitions, (c) a non-Claude
model catalog + a write path to add a provider without hand-editing JSON.

---

## 2. Current state (cited)

### 2.1 Model + effort assignment and flow

**Runtime set** — `setWorkerModel` (`core/src/use-cases/SetWorkerModel.ts:37-83`):
```ts
deps.workers.updateModel(input.workerId, input.model, effort);   // :54 — always persists
// ...
const session = deps.backend.attach(w.id, handle);
if (session.isAlive() && session.capabilities.runtimeModelSwitch) {  // :63 — capability-gated, never kind
  const r = await session.setModel(input.model, effort);
  runtimeApplied = r.ok;
}
```
Effort is normalized against the model's capability list, fail-open on unknown
(`resolveEffort`, `core/src/domain/effort.ts:9-27`; `deps.caps.effortLevelsFor`,
`core/src/ports/ModelCapabilities.ts:3-8`). **It touches `model`+`effort` only — never kind / profile /
provider.** On the in-process lane `setModel` is a hard no-op (`runtimeModelSwitch:false`,
`infra/src/backends/InProcessBackend.ts:113`), so an API-lane model change persists for next spawn only.

**Spawn-time model resolution** has three tiers (`manager/commands/handlers/spawn-worker.ts:104-131`):
- request `body.model` wins (explicit);
- else the worker definition's `model` default fills it
  (`applyWorkerDefinitionDefaults`, `core/src/domain/worker-definition-resolution.ts:84-97` — request-set
  fields are never overridden);
- for a `modelSource:"profile"` backend, `rb.model` from the profile overrides
  (`spawn-worker.ts:122`: `...(backend.descriptor.modelSource === "profile" ? { model: rb.model } : {})`).

So **request-model lanes** (claude-cli/claude-sdk, `descriptor.modelSource:"request"`) run the picked
Claude model; **profile-model lanes** (the metered/API lanes, `modelSource:"profile"`,
`InProcessBackend.ts:55-57`) run the model the profile fixes. This `modelSource` split is the hinge for
the whole API-lane UX (§4).

### 2.2 Model abstraction ports

- **`ModelCatalog`** (`core/src/ports/ModelCatalog.ts`) is *pricing only* — `priceFor(model)`
  (`core/src/domain/value-objects.ts:57-87`). The adapter is Claude-substring matching, defaulting to
  opus (`manager/container.ts:233-244`); prices are Claude-only (`DEFAULT_PRICES`,
  `manager/shared/config.ts:184-193`: fable/opus/sonnet/haiku), but `config.prices` is a
  user-extensible `Record<string, ModelPrice>` — adding `"glm-5.2": {...}` is config-only.
- **`ModelCapabilities`** (`core/src/ports/ModelCapabilities.ts:3-8`) — `effortLevelsFor(model)`,
  returns `null` (unknown → fail-open). The adapter is `ModelCatalogService`
  (`manager/services/ModelCatalogService.ts:31-59`), which fetches `https://api.anthropic.com/v1/models`
  via the Claude OAuth token and caches to `~/.eos/models.json` (`:55-59`, `:113-124`). **Claude-only
  source** — non-Claude models get `null` (effort passes through untouched).
- **`ModelClient`** (`core/src/ports/ModelClient.ts:17-43`) — the neutral `createTurn`/`streamTurn`
  contract (dim 01/06 turf); model *selection* decides which client is built.
- **`ModelCatalogRef`** (`core/src/ports/AgentBackend.ts:55-58`) — what the UI picker shows per provider:
  ```ts
  | { kind: "claude" }                              // claude-cli + claude-sdk: bundled /v1/models
  | { kind: "static"; models: readonly string[] }  // explicit SKU list — the seam for GLM/DeepSeek/local
  | { kind: "openai-compatible" }                   // openai/codex use THIS — and it carries NO model list
  ```
  The `static` variant is the existing, unused seam to enumerate non-Claude SKUs; `openai`/`codex`
  descriptors instead use `{kind:"openai-compatible"}` (`InProcessBackend.ts:56-57`), which gives the
  picker nothing to show.

### 2.3 Credentials / auth resolution

- **`AuthRef`** (`contracts/src/backend.ts:17-23`) is a *reference*, never a secret:
  `{ kind: "subscription" | "env" | "keychain", ref?: string }`.
- **`AuthResolver` → `ResolvedAuth`** (`core/src/ports/AuthResolver.ts:9-24`):
  `{ scheme: "oauth"|"apikey"|"none", token?, apiKey?, baseUrl? }`. Note `baseUrl` is in the port's
  return shape.
- **`SubscriptionAuthResolver`** (`infra/src/auth/SubscriptionAuthResolver.ts:48-67`):
  `subscription` → OAuth token; `env` → `process.env[ref]`; `keychain` → `readKeychainSecret(ref)`.
  **`ResolvedAuth.baseUrl` is never populated** (the field exists but the adapter doesn't set it), and
  **the resolver is only called by `claude-sdk`** (`manager/backends/sdk/ClaudeSdkBackend.ts:236`, with
  `opts.auth` that the spawn handler never sets → undefined → subscription). The **in-process API lane
  never calls `authResolver`** — it reads `process.env` directly (§2.5).

### 2.4 BackendProfile, the config registry, and where profiles live

`BackendProfile` (`contracts/src/backend.ts:25-37`): `kind, model, baseUrl?, auth?, pricing?, costMode?,
params?`. Stored in `config.backends` (`manager/shared/config.ts:33-151`, `DaemonConfig`), per-role
defaults in `config.defaults.{orchestrator,worker}.backend` (`contracts/src/backend.ts:40-46`). Built-in
profiles (`DEFAULT_BACKENDS`, `config.ts:195-207`): `claude-sdk-opus` (with `auth:{kind:"subscription"}`,
`costMode:"included"`, `params:{thinking:…}`), `claude-cli-opus/sonnet/haiku`. Both role defaults are
`"claude-sdk-opus"` (`config.ts:272-275`).

Config is **file-based and frozen**: `loadConfig` reads `~/.eos/config.json`, merges over defaults,
`deepFreeze`s the result at boot (`config.ts:509-560`, freeze at `:537`); precedence env → config.json →
defaults. (Per CLAUDE.md, runtime mutation = write `~/.eos/config.json` then `container.reloadConfig()`.)

The `BackendDefaults` adapter (`manager/container.ts:274-283`) is where the AuthRef is **first dropped**:
```ts
profile(name) {
  const p = config.backends[name];
  if (!p) return null;
  return { kind: p.kind, model: p.model, profileName: name,
           baseUrl: p.baseUrl, pricing: p.pricing, costMode: p.costMode, params: p.params };
           //  ^^ p.auth is NOT mapped — ResolvedBackend has no auth field (BackendDefaults.ts:8-16)
}
```

### 2.5 Where per-profile config dies (the threading gap, confirmed)

1. **Resolver → spec.** `resolveSpawnBackend` (`manager/shared/spawn-backend.ts:15-46`) returns the full
   `ResolvedBackend` (minus `auth`, already dropped). The handler threads only:
   ```ts
   ...(backend.descriptor.modelSource === "profile" ? { model: rb.model } : {}),  // spawn-worker.ts:122
   backendProfile: rb.profileName ?? undefined,                                    // :123
   ```
   `rb.baseUrl`/`rb.pricing`/`rb.costMode`/`rb.params` are dropped here. (`costMode` is read once by the
   `spawnBackendError` guard at `spawn-backend.ts:55-63`, never persisted.)
2. **spec → adapter.** `SpawnWorkerSpec` (`core/src/use-cases/SpawnWorker.ts:24-88`) has `model` and
   `backendProfile` (name) but no `baseUrl`/`auth`/`params`. `spawnWorker` calls `backend.start(...,
   backendOptions: { spec: withBranch })` (`SpawnWorker.ts:240-256`) — only the spec, no
   `auth`/`baseUrl`/`params`. `BackendLaunchOptions` (`core/src/ports/AgentBackend.ts:104-110`) *has*
   `auth?` and `params?` but **no `baseUrl`** — and none are populated.
3. **adapter → client.** The in-process factories read globals (`manager/container.ts:758-776`):
   ```ts
   createInProcessBackend("anthropic-api", (spec) => ({
     model: createAnthropicModelClient({ apiKey: process.env.ANTHROPIC_API_KEY ?? "", model: spec.model, tools }),  // :761 — no baseUrl
     …}));
   const openaiEnv = (spec) => ({
     model: createOpenAIModelClient({ apiKey: process.env.OPENAI_API_KEY ?? "", model: spec.model, baseUrl: process.env.OPENAI_BASE_URL, tools }),  // :771 — global baseUrl
     …});
   ```
   The clients accept `baseUrl` and default to the public host
   (`infra/src/backends/AnthropicModelClient.ts:29-31`, `OpenAIModelClient.ts:27-29`), but the spawn path
   never supplies a per-worker one. **The env factory does receive the full `AgentLaunchSpec`**
   (`InProcessBackend.ts:30,128-142`: `env: envFactory(spec)`), so the seam to fix this exists — it's
   used to read globals instead of `spec`.

### 2.6 Worker definitions across scopes

Four sources, nearest-wins by name: builtin (`config.paths.workerDefinitionsDir`) < user
(`~/.eos/workers`) < project (`.eos/workers` walked up from cwd) < runtime (SQLite store)
(`manager/container.ts:556-569`; `FileWorkerDefinitionSource.list`,
`infra/src/worker-definition/FileWorkerDefinitionSource.ts:31-43`; project discovery `:48-59`).
A def declares `model?`, `effort?`, `permissionMode?`, `backendKind?` — **never a profile**
(`contracts/src/worker-definition.ts:22,25`). Examples: `manager/workers/general-purpose.md` (all axes
omitted → inherit), `manager/workers/git.md` (`model: sonnet`, `effort: medium`,
`permissionMode: bypassPermissions`). The merge applies a def default only where the request left the
field unset (`worker-definition-resolution.ts:84-97`).

### 2.7 Orchestrator assignment

`POST /orchestrators` (`manager/routes/orchestrators.ts:23-66`): resolves backend via
`resolveSpawnBackend(c, { explicitKind: body.backendKind, isOrchestrator: true })`, guards with
`spawnBackendError`, then `spawnWorker(..., { isOrchestrator: true, model: backend.descriptor.modelSource
=== "profile" ? rb.model : (body.model ?? "opus"), backendProfile: rb.profileName ?? undefined, … })`.
The resolver, with no parent to climb, lands on `config.defaults.orchestrator.backend`
(`SqlBackedBackendResolver.ts:60-62` → `backendDefaults.roleDefaultName(true)`,
`container.ts:280-281`). **Same path as workers**, just `isOrchestrator:true`.

### 2.8 DPI prompt assembly

`assembleSystemPrompt(deps, ctx, extraFragments)` (`core/src/use-cases/AssembleSystemPrompt.ts:58-78`),
once per spawn. Fragments are `Fragment { prompt, dpi }` (`core/src/domain/prompt.ts:41-44`) with
`DpiMeta { layer, priority, when?, overrides? }` (`contracts/src/prompt.ts:61-67`); `when` is a
`Condition` leaf/`all`/`any`/`not` over a `fact` (`contracts/src/prompt.ts:21-34`). The fact set is
`SessionFacts` (`contracts/src/prompt.ts:88-109`): `role, isSubagent, isGitRepo, isWorktree, isAttached,
model, effort, permissionMode, os, shell, hasMcp, canCollaborate, workerDefinition`. `model`/`effort` are
present **as render variables only** (`{{MODEL}}`, `{{EFFORT}}`); the hard rule (CLAUDE.md:51) is that a
fragment `when` may gate ONLY on session-immutable facts (`role`, `isSubagent`, `isWorktree`,
`workerDefinition`) — never `model`/`effort`/`backend`. **There is no `backend`/`provider` fact at all**,
and **no test enforces the immutable-only rule** (discipline + assembly-timing only). Provider-specific
prompt text, if ever needed, must come through the assembly *lane parameter*
(`assembleAppendFor(spec, id, "claude-cli")`), which is known at assembly time (backend is resolved
*before* the prompt, `spawn-worker.ts:97-103`).

### 2.9 User-facing config surface (what exists)

`GET /api/ui-config` exposes `models: Object.keys(config.prices)`, the live `modelCatalog`, `prices`, and
`backends: c.backends.descriptors().map(...)` (`manager/routes/uiConfig.ts:5-22`). `PUT /workers/:id/model`
and `PUT /workers/:id/backend` switch a running worker's model / backend-kind
(`manager/routes/workers.ts:743-767`). **There is NO route/MCP tool/UI to add a provider profile, set an
API key + base URL, or register a non-Claude model** — providers exist only by hand-editing
`~/.eos/config.json` (file-based, restart/reload required).

---

## 3. Gaps & missing pieces for the API lane

**STUBBED / DISABLED / no-write (cited):**
- Profile `auth` (`AuthRef`) dropped at `BackendDefaults.profile` (`container.ts:278`); `ResolvedBackend`
  has no `auth` field (`BackendDefaults.ts:8-16`).
- `baseUrl`/`pricing`/`costMode`/`params` dropped at `spawn-worker.ts:122-123`.
- In-process factories read global `process.env`, never `authResolver`/`spec` (`container.ts:758-776`).
- `BackendLaunchOptions` has no `baseUrl` (`AgentBackend.ts:104-110`); `auth`/`params` exist but unused.
- `openai`/`codex` descriptors carry no model list (`{kind:"openai-compatible"}`, `InProcessBackend.ts:56-57`).
- `ModelCapabilities`/prices are Claude-only sources (`ModelCatalogService.ts:55-59`,
  `container.ts:233-244`); `config.prices` defaults are Claude-only (`config.ts:184-193`).
- `AuthRef` enum has no `none`/inline kind for keyless localhost (`contracts/src/backend.ts:18`).

**MISSING for the goal:**
- **Per-worker provider config threading** (the dim-01 gap, my §4 design): nothing carries a profile's
  `auth`/`baseUrl`/`params` from resolver → spec → in-process client.
- **A `backendProfile` field on worker definitions** so any built-in/project/user/runtime worker scope
  can pin a provider (not just a bare `model`+`backendKind`).
- **A non-Claude model catalog** for the picker + pricing (per-profile `static` SKU list or
  profile-as-picker; price entries per model).
- **A write path to add a provider** (API key + base URL) without hand-editing JSON, with secret
  storage as a reference (Keychain/env), never raw in `config.json`.
- **Keyless-localhost auth** (Ollama/vLLM/LM Studio often need no key) — `AuthRef` + the OpenAI client
  must tolerate an empty key.

---

## 4. Design implications & options (SOLID-aligned; ports/types/files named)

The reframing that makes the whole goal tractable: on `modelSource:"profile"` lanes a **`BackendProfile`
IS the unit of model selection** — it bundles `{kind (dialect), model, baseUrl, auth, params}`. So
"assign GLM-5.2 over my localhost key to worker X" = "assign the `glm-local` profile to worker X." This
uses existing machinery (resolver precedence, role defaults, `modelSource`) and matches sibling 06's
"new provider = a `BackendProfile`, no new class." The work is plumbing + two schema fields + a catalog +
a write path.

### 4.1 Config schema (mostly EXISTS; add three small things)

A provider profile is already expressible today — e.g. user writes to `~/.eos/config.json`:
```jsonc
"backends": {
  "glm-local": { "kind": "openai", "model": "glm-5.2",
                 "baseUrl": "http://localhost:11434/v1",
                 "auth": { "kind": "keychain", "ref": "eos-glm" },   // or {kind:"env",ref:"GLM_KEY"}, or keyless (see below)
                 "costMode": "billed",
                 "params": { "temperature": 0.2, "max_tokens": 8192 } },
  "deepseek": { "kind": "openai", "model": "deepseek-chat",
                "baseUrl": "https://api.deepseek.com", "auth": { "kind": "env", "ref": "DEEPSEEK_KEY" },
                "costMode": "billed" }
},
"defaults": { "orchestrator": { "backend": "glm-local" }, "worker": { "backend": "glm-local" } }
```
Additions needed:
- **`AuthRef.kind` gains `"none"`** (`contracts/src/backend.ts:18`) for keyless localhost; the resolver
  returns `scheme:"none"` and the OpenAI client must send no `Authorization` header / tolerate an empty
  key (`infra/src/backends/OpenAIModelClient.ts`).
- **Per-profile model catalog hint** so the picker can show non-Claude SKUs: either store the profile's
  selectable models and surface `ModelCatalogRef {kind:"static", models}` (`AgentBackend.ts:57`), or make
  the UI offer *profiles* directly (recommended — see 4.4). Price entries go in `config.prices`
  (extensible) keyed by the profile's `pricing` or `${kind}:${model}`.

### 4.2 Per-worker provider plumbing (the key enabler — my owned fix)

**Recommended (B-explicit, DIP-clean): carry the profile's *references* (not secrets) to the factory and
resolve lazily at `start()`.** Secrets must never enter the persisted `SpawnWorkerSpec`/worker row, so the
`AuthRef` (a reference) travels and the apiKey is resolved inside the factory:

1. `ResolvedBackend` (`core/src/ports/BackendDefaults.ts:8-16`): add `auth?: AuthRef`.
2. `backendDefaults.profile()` (`manager/container.ts:278`): map `auth: p.auth`.
3. `BackendLaunchOptions` (`core/src/ports/AgentBackend.ts:104-110`): add `baseUrl?: string`
   (`auth?`/`params?` already exist).
4. Spawn chokepoints (`manager/commands/handlers/spawn-worker.ts:104-131` and
   `manager/routes/orchestrators.ts:30-60`): pass the resolved `rb` into `spawnWorker` so it can forward
   `backendOptions: { spec, auth: rb.auth, baseUrl: rb.baseUrl, params: rb.params }` at
   `SpawnWorker.ts:256` (currently `{ spec }` only).
5. The in-process `InProcessEnvFactory` becomes **async** (`infra/src/backends/InProcessBackend.ts:30`
   → `(spec) => Promise<InProcessEnv>`; `start` awaits at `:134`). The factories
   (`container.ts:758-776`) read `spec.backendOptions.{auth,baseUrl,params}`, do
   `const creds = await authResolver.resolve(auth)`, and build
   `createOpenAIModelClient({ apiKey: creds.apiKey ?? "", baseUrl: baseUrl ?? creds.baseUrl, model: spec.model, ...params })`.
   Drops every `process.env.*` read. The composition root keeps owning credential resolution (DIP); the
   adapter stays env-agnostic.

**Lighter alternative (B-minimal): re-resolve by profile name in the factory.** `backendOptions.spec.backendProfile`
*already* threads (the NAME). The factory could `config.backends[name]` + `authResolver.resolve(profile.auth)`
itself — zero new fields, just the async-factory change. Tradeoff: the adapter reaches into global config
(weaker DIP) and ad-hoc (profileless) picks get no baseUrl. Prefer B-explicit; B-minimal is the smallest
diff if speed dominates.

Either way the single structural change that *unblocks the user goal* is **threading the profile's
`auth`+`baseUrl`+`params` to the in-process model client per worker.**

### 4.3 Assign any model to EVERY worker scope (the `backendProfile` field)

Add `backendProfile?: z.string().optional()` to `WorkerDefinitionSchema`
(`contracts/src/worker-definition.ts:25`, alongside `backendKind`), carry it in
`applyWorkerDefinitionDefaults` (`core/src/domain/worker-definition-resolution.ts:84-97`), and feed it as
`explicitProfileName` into the resolver (which already honors it first,
`SqlBackedBackendResolver.ts:39-42`). Then a built-in (`manager/workers/*.md`), project
(`.eos/workers/*.md`), user (`~/.eos/workers/*.md`), or runtime (`create_worker`) definition can declare
`backendProfile: glm-local` and run on GLM. `model`/`backendKind` stay for backward compatibility (a bare
model on a request-model lane). This is the ISP-clean addition — one optional field, one resolver tier
already present. (LSP note: a profile-pinned def on a `modelSource:"profile"` lane ignores any composer
model — correct, the model is profile-fixed.)

### 4.4 Model catalog + picker (profile-centric)

Because metered lanes are `modelSource:"profile"`, the cleanest picker is **"pick a profile," not "pick a
model string."** Surface `config.backends` (name + kind + model + label) in `GET /api/ui-config`
(`manager/routes/uiConfig.ts`) so the UI lists configured providers; the worker's model is then the
profile's model. For request-model lanes keep the existing Claude `{kind:"claude"}` catalog. This avoids
inventing a live `/v1/models` fetch per provider (defer that), satisfies "assign any model," and reuses
the existing `descriptor.modelSource` branch. Pricing: extend `config.prices` per non-Claude model;
`priceFor` (`container.ts:233-244`) already falls through to a default. `effortLevelsFor` returns `null`
for non-Claude → effort passes through (acceptable; OpenAI-effort vs Anthropic-thinking handling is dim
01/06 turf via `params`).

### 4.5 User-facing "add a provider by key/localhost"

Add a write path (the missing surface, §2.9). Recommended: a route (e.g. `POST /api/backends`, ROUTES in
`contracts/src/http.ts`) that (a) writes the user's API key to macOS Keychain via a new
`writeKeychainSecret` companion to `readKeychainSecret`
(`infra/src/auth/SubscriptionAuthResolver.ts`), (b) writes a `BackendProfile` with
`auth:{kind:"keychain", ref}` (or `{kind:"none"}` for keyless localhost) + `baseUrl` + `model` to
`~/.eos/config.json`, (c) calls `container.reloadConfig()`. **The raw key is never stored in
`config.json` or SQLite** — only the reference. This keeps the "creds are references, resolved lazily,
never persisted/logged" invariant (`AuthResolver.ts:1-7`). A localhost provider with no key uses
`auth:{kind:"none"}` + a `baseUrl` like `http://localhost:11434/v1`. (Permission/secret-exposure concerns
on this route are dim 05's seam.)

### 4.6 DPI

No change to the `when` model — provider must NOT become a gateable fact (would violate CLAUDE.md:51).
If a provider needs different harness instructions (e.g. tool-use phrasing for a weak local model), drive
it through the assembly **lane parameter** (`assembleAppendFor(spec, id, kind)`), which already varies by
backend and is computed after backend resolution. Recommend adding a guard test for the immutable-`when`
rule (none exists) since the API lane multiplies the temptation to gate on model/provider.

---

## 5. Open questions / conflicts with sibling dimensions

- **Correction to dim 01 (§3.2):** dim 01 says the resolver "computes `ResolvedBackend.baseUrl/auth/params`."
  `ResolvedBackend` has **no `auth` field** (`BackendDefaults.ts:8-16`); the `AuthRef` is dropped at
  `BackendDefaults.profile` (`container.ts:278`), one hop earlier than dim 01 implies. The fix must add
  `auth` to `ResolvedBackend`, not just thread an existing field. (Confirmed: dim 01 Option B and my §4.2
  otherwise agree.)
- **Dim 01 (lifecycle):** my plumbing assumes the in-process lane is *enabled* and *durable*. It is gated
  off (`enabled:false`) and non-resumable (`sessionStore:"none"`) per dim 01 §3. Threading config does
  not fix durability — a profile-pinned orchestrator still dies on daemon restart until dim 01's
  `ConversationStore` exists. Also: `PUT /workers/:id/backend` can't move a worker *onto* the API lane
  live (handoff needs a shared `sessionStore`, `canHandoffBackend`); provider assignment is effectively
  spawn-time. Coordinate so "assign on spawn" is the supported path, not "switch live."
- **Dim 06 (dialects/capabilities):** my `BackendProfile.params` is where 06's typed `ProviderCapabilities`
  (wire, reasoningRoundTrip, supportsTools, cache, contextWindow…) should live. Open question for the
  architect: promote `params` to a typed `ProviderCapabilities` in `contracts/` (more SOLID, touches all
  dims) or keep it loose and read keys defensively. I recommend typed, scoped to the API lane, so the
  model-client adapters branch on declared capability not on model-name heuristics.
- **Dim 02/03 (tool harness / MCP):** the in-process factory builds the tool surface via
  `buildLaneTooling(spec)` in the SAME closure I'm modifying (`container.ts:758-776`). My async-factory
  change must not disturb that — coordinate that `buildLaneTooling` stays sync and only credential
  resolution becomes async.
- **Dim 05 (permissions):** the `POST /api/backends` write route (§4.5) introduces a new secret-bearing
  endpoint and a profile-add capability — its authz + secret-exposure handling is dim 05's call.
- **Open question (effort/pricing for non-Claude):** `ModelCapabilities` + `priceFor` are Claude-only
  sources. Is per-provider effort/price *declared in config* (recommended, mirrors 06's declarative
  capability map) or *probed*? If declared, `config.prices` + a per-profile capability block suffice; if
  probed, a new catalog port per dialect is needed (heavier). Recommend declarative.
