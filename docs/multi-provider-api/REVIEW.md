# Adversarial Review — Multi-Provider API Lane Plan (`00-PLAN.md`)

> Hostile staff-engineer review. Mandate: find what is wrong, missing, or weak —
> the user demanded a flawless, "no structure missing" plan, so a rubber-stamp is
> a failure. Every code claim below was re-verified against `feat/multi-provider-api`
> with the cited `file:line`. The plan's own citations were spot-checked and are
> **highly accurate** — the findings here are about *completeness and design*, not
> bad cites.

## VERDICT

**NOT implementation-ready as-is.** The plan is unusually well-grounded and its
core thesis (capability-seam, two dialects, registry extension points) is sound —
but it contains **one BLOCKER** (the API lane has no system-prompt / DPI wiring at
all, and the plan never adds it) plus **7 MAJOR** gaps that defeat or under-specify
G2/G3/G4. Fix B1 + the MAJORs and it becomes implementation-ready.

Counts: **1 BLOCKER · 7 MAJOR · 6 MINOR.**

---

## [BLOCKER]

### B1 — The API lane never receives a system prompt / DPI; the plan never wires one. (defeats G2, G3, G4)

**Location:** plan §1, §4.1 diagram, §5c, §5d step 4, §11 (`manager/container.ts` change list). The omission spans all of them.

**Problem.** The in-process model clients are built with **no `system` field**, and
nothing assembles the DPI prompt for this lane:
- `manager/container.ts:761` — `createAnthropicModelClient({ apiKey, model: spec.model, tools })` — no `system`.
- `manager/container.ts:771` — `createOpenAIModelClient({ apiKey, model, baseUrl, tools })` — no `system`.
- `infra/src/backends/InProcessBackend.ts:140` — `start` pushes only `spec.prompt` (the user task) as a `user` message; it never reads `spec.systemPromptFile` and the factory never calls `assembleAppendFor`.
- The DPI raw materials *are* on the spec (`spawn-worker.ts:106` `prompt = bootPrompt` = task only; `:127-128` `workerDefinition`/`workerDefinitionBody`), but `assembleAppendFor(...)` is invoked **only** by the SDK lane (`container.ts:804`) and the CLI lane (via `--append-system-prompt-file`). The in-process lane is not wired to it.

The model clients already accept a `system` string (`AnthropicModelClient.ts:23,37`,
`OpenAIModelClient.ts:23,37`), so the *target* exists — the plan simply never connects
spec → `assembleAppendFor` → `system`.

**Why it matters.** The codebase documents the consequence itself, on the SDK lane:
without the assembled append "an SDK agent boots with only the stock claude_code
prompt and **never learns the Eos orchestration protocol — so it has the MCP tools
but ignores them**" (`ClaudeSdkBackend.ts:73-77`). On the API lane the situation is
worse: there is no `claude_code` preset either, so an API worker gets **no role
framing, no reporting contract, no worker-definition body/persona, and no injected
project/user memory (CLAUDE.md)**. This directly breaks:
- **G2** ("full SDK/CLI feature set") — parity is impossible without the protocol the SDK gets from its append.
- **G3** ("assign any model to all worker scopes ... interoperating seamlessly") — a project/user worker's instructions live in `def.body` → DPI. With no DPI slot, a `glm-local` worker has its *tools* but not its *instructions*. It is a different agent than the same definition on the SDK lane.
- **G4** — DPI is a central architectural element; leaving it unwired is "structure missing."
- It **cascades into M6**: §5c says skill trigger metadata is "injected into the assembled DPI prompt (dim 4 owns the prompt slot)" — but on this lane **that slot is never created**. The skills design rests on a prompt that the plan never assembles.

The plan's "~70% built … already passes the backend conformance suite" framing (§1, §3.1)
**hides this**: the conformance suite runs a *fake* `ModelClient` with scripted turns
(`agent-backend-conformance.ts`, finding 01 §2.5) — it never exercises a system prompt,
a real model, or real tools, so it is zero evidence the lane runs an actual worker.

**Fix.** Add an explicit design step + milestone item (belongs in **M1**, the foundation):
in the in-process env factory (or `InProcessBackend.start`), call
`assembleAppendFor(spec.backendOptions.spec, spec.workerId, <lane>)` and pass the
result as `system` to the model client. Decide the lane parameter value (a new
`assembleAppendFor` lane arg, e.g. `"in-process"`, vs reusing `"claude-sdk"`), and
note that on this lane there is no `claude_code` preset, so the append must be a
**complete** system prompt, not a delta. Add this to the §11 `container.ts` change
list and to the M1 acceptance test (assert the model client receives a non-empty
`system` containing the worker protocol + definition body). Until this exists, no
G2/G3 acceptance test can pass.

---

## [MAJOR]

### MJ1 — `baseUrl` `/v1` path-join: the plan's own example/acceptance config is wrong vs the client. (hits G1)

**Location:** plan §2.1 (G1 acceptance), §7.1 config example.

**Problem.** `OpenAIModelClient` strips a trailing slash and appends the version path
itself: `base = (opts.baseUrl ?? "https://api.openai.com").replace(/\/$/,"")`
(`OpenAIModelClient.ts:29`) then POSTs to `${base}/v1/chat/completions`
(`:41`, `:67`). The plan's G1 acceptance (§2.1) and config (§7.1) use
`"baseUrl": "http://localhost:11434/v1"` — which yields
`http://localhost:11434/v1/v1/chat/completions` (**doubled `/v1`**). The Anthropic
client has the same shape: `${base}/v1/messages` (`AnthropicModelClient.ts:43`).

**Why it matters.** G1's own acceptance test ("an integration test asserting the
URL+auth the model client receives") would fail on the plan's example. Worse, the
plan never *defines* the baseUrl convention (does the user include `/v1` or not?),
and real providers are inconsistent: Ollama documents `http://localhost:11434/v1`,
DeepSeek documents both `https://api.deepseek.com` and `.../v1`. Without a stated
convention + validation, every localhost/proxy onboarding is a coin-flip 404.

**Fix.** Define the convention explicitly (recommend: baseUrl is the **origin only**,
the client owns the version + path), normalize/validate it on the `POST /api/backends`
write path (reject or strip a trailing `/v1`), correct the §7.1 / §2.1 examples to
`"http://localhost:11434"`, and assert the exact composed URL in the M1 test.

### MJ2 — Per-provider cost defaults to **Opus pricing**; the "billed" lane over-bills from the moment it is enabled. (hits G1, G4)

**Location:** plan §5a ("add non-Claude entries as config"), §8 M1 (enables lane + `costMode:"billed"`), §10 D7. Not scheduled as a correctness item.

**Problem.** `priceFor` substring-matches Claude names and **falls through to
`config.prices.opus`** for anything unrecognized: `return config.prices.opus`
(`container.ts:242`). A `deepseek-chat` / `glm-5.2` / local model with no configured
price entry is billed at **Opus rates** through the cost ledger (`handleUsage` →
`models.priceFor`). M1 turns the lane on with `costMode:"billed"` but schedules no
pricing/validation work.

**Why it matters.** The entire point of a *metered* lane is accurate cost; silently
billing a 10×-cheaper model at Opus rates is a correctness defect, not a UX nicety,
and it is live the instant M1 ships. The plan mentions "add prices as config" but
never (a) flags the Opus-default trap, (b) requires a price per metered profile, or
(c) adds an observable warning when a billed turn has no matching price.

**Fix.** In M1: require/validate a `prices` (or per-profile `pricing`) entry for any
`costMode:"billed"` profile at config-load or at `POST /api/backends`; change the
`priceFor` fallback for unknown models to a loud zero/known-unknown rather than Opus,
or emit a one-time warning event. Add to the M1 acceptance test.

### MJ3 — No retry / backoff / rate-limit handling; a single 429 or 5xx kills the turn. (missing structure flagged in the directive)

**Location:** plan §5g ("OpenAI-compatible robustness") covers malformed streams but is silent on transport retries. Not in any milestone.

**Problem.** Both clients do a single `fetch`; on `!resp.ok` they return
`{ stopReason:"error", error:"HTTP 429…" }` (`OpenAIModelClient.ts:49-51`,
`AnthropicModelClient.ts:55-58`), and `ToolRuntime` ends the turn on
`stopReason === "error"` (`ToolRuntime.ts:83-86`). There is **no retry, no backoff,
no `Retry-After` handling** anywhere.

**Why it matters.** DeepSeek/GLM/OpenAI rate-limit aggressively; a metered orchestrator
that dies on the first 429 mid-task is not production-grade. The directive explicitly
lists rate-limit/retry/backoff as a required structure; the plan claims robustness
(§5g) but omits it.

**Fix.** Add a capability-gated retry policy (bounded exponential backoff honoring
`Retry-After`, on 429/500/502/503/529) in the two model clients, distinct from a
"hard error" that ends the turn. Schedule it (M4 fits, "provider normalization
hardening"). Note it is shared infra, not a per-provider branch.

### MJ4 — No context-window management / compaction; `messages` grow unbounded; `contextWindow` is declared-but-unused. (hits G1 localhost models, G2 parity)

**Location:** plan §4.2 / §6 (`ProviderCapabilities.contextWindow`), §2.2 (no compaction listed). No design uses `contextWindow`.

**Problem.** The loop never trims history — `runTurn` slices then only *pushes*
assistant/tool messages (`ToolRuntime.ts:93,99`), and `InProcessBackend` accumulates
`s.messages` across every turn (`InProcessBackend.ts:80`). The plan adds
`contextWindow` to `ProviderCapabilities` but **no step reads it**. There is no
compaction/summarization, and `model_context_window_exceeded` maps to a generic error
(`AnthropicModelClient.ts:96-97`; plan §11 notes the Anthropic mapping but not a recovery).

**Why it matters.** G1 explicitly targets **local models by localhost base URL** —
which usually have small context windows (8k–32k). Unbounded growth guarantees a
hard 400 within a few tool turns, with no recovery. The SDK/CLI lanes get
auto-compaction from the bundled binary "for free"; the API lane has none, so this is
also a direct **G2 parity gap**. A "declared but never enforced" capability is exactly
the kind of latent hole the mandate forbids.

**Fix.** Either (a) design a compaction step in the loop (drop/summarize oldest turns
when projected tokens approach `capabilities.contextWindow`), or (b) explicitly scope
it as a documented non-goal with a guard that fails fast with a clear message. Don't
ship a `contextWindow` field nothing reads.

### MJ5 — `Task` (subagent) on the API lane is hand-waved; it is the 2nd-largest net-new surface and G2 lists it. (hits G2)

**Location:** plan §5b (inventory: "API-lane subagent = nested `runTurn` … without control tools"), §5e (Task isolation).

**Problem.** "Nested `runTurn` built without control tools" is the entire design. But
a built-in is a bare `RuntimeTool` whose `execute(input)` receives only `input`
(`ToolRuntime.ts:16-19`) — it has **no handle to the env factory, model client, gate,
or `emit`** needed to build and run a child loop. The plan does not specify:
- where the nested loop's `model`/`tools`/`gate`/`emit`/`signal` come from;
- how `subagent_type` (Explore/Plan/general-purpose) maps to a child **system prompt** — which on this lane doesn't exist yet (**compounds B1**); a subagent with no role prompt is useless;
- how child events surface to the FSM/UI (reuse parent `emit`? a namespaced child stream?);
- recursion-depth limits and abort propagation (a nested `runTurn` blocks the parent's `executeGated` await synchronously).

**Why it matters.** G2 demands "every built-in tool"; `Task` is in the inventory and
is how workers parallelize. A one-line "nested runTurn" is not an implementable design.

**Fix.** Give `Task` a real design: pass a sub-environment factory into the built-in
(closure over the in-process factory + a child `emit` that re-tags events with a
sub-agent id), define `subagent_type` → child DPI prompt (depends on B1), set a depth
cap, and decide event surfacing. Pair with the §5e `agentId` rung-0.5 isolation
(`PolicyGatewayService.ts:139`).

### MJ6 — Skills (the "largest net-new surface", G2) rests on the missing prompt slot and omits resource/path handling. (hits G2)

**Location:** plan §4.4, §5c, M6.

**Problem.** Two structural gaps: (1) skill trigger-metadata injection targets "the
assembled DPI prompt" (§5c) that B1 shows is never assembled on this lane — so the
discovery half works but skills will not *auto-surface*; (2) skill-bundled
scripts/assets need `cwd`/path resolution so `Bash` can run them (finding 03 §3.2 #4),
which the plan does not carry forward. Combined with the explicit deferral of
auto-trigger (§2.2), an API agent's skills are strictly weaker than SDK/CLI's.

**Why it matters.** G2 names skills as first-class ("MCP, skills, everything"). The
plan delivers discovery + manual `Skill` invocation only, and even the metadata
injection it promises is blocked on B1.

**Fix.** Resolve B1 first (the prompt slot), then route skill metadata into it; specify
skill-resource path resolution; and **state plainly in the G2 coverage that v1 skills
are discovery + manual-invoke, not auto-trigger parity** (it's a reasonable scope cut
— just don't let G2 read as "full parity").

### MJ7 — Durability injection seam + sessionId source unspecified; `attach()` yields a dead-but-"alive"-looking session after restart. (hits G3)

**Location:** plan §5f, §11 (`InProcessBackend.ts` MOD), M3.

**Problem.** The conceptual design (C1) is sound, but the wiring is missing:
`ConversationStore` is not part of `InProcessEnv` (`{model,tools,gate}`,
`InProcessBackend.ts:25-29`) and `createInProcessBackend(kind, envFactory)`
(`:66`) has no store parameter — so the plan never says **how the store reaches
`start`/`kickTurn`** to save after each turn or to rehydrate on resume. It also
doesn't name the **sessionId generator** (the codebase uses an injected id generator,
not `Math.random`). And `attach(workerId)` returns `sessionFor(workerId)`
**unconditionally** (`:143-145`) — after a restart with no live entry, methods 410 but
`isAlive()`/the returned session look valid; the plan relies on resume-via-`start` but
never addresses attach's misleading liveness (finding 01 §3.1 flagged it).

**Why it matters.** G3's restart acceptance ("assignment survives a daemon restart")
depends on this seam. "Persist after each settled turn" is unimplementable without the
store reference threaded into the backend.

**Fix.** Add a `store`/`ids` parameter to `createInProcessBackend` (or fold the store
into `InProcessEnv`), specify the save point (the `kickTurn` `.then`), the sessionId
source, and either fix `attach` to signal absence or document that resume always goes
through `start`.

---

## [MINOR]

- **m1 — `streamingThinking` per-kind needs `sessionFor`/`CAPS` to vary, not just the descriptor.** The session caps returned to dispatch/UI are the shared const `CAPS` (`InProcessBackend.ts:44-51`, used at `:89`), identical to the descriptor caps. The UI gates live-thinking on the *session* capability. The plan says "per-kind caps" (§5f, §11) but cites only `IN_PROCESS_DESCRIPTORS`; note that `sessionFor`'s `CAPS` must also become kind-aware.

- **m2 — Anthropic non-streaming `createTurn` can't be interrupted mid-request until M4.** `createTurn` awaits the whole HTTP body (`AnthropicModelClient.ts:33-59`); abort is only checked between round-trips (`ToolRuntime.ts:43`). `streamTurn` lands in M4, so M1–M3 Anthropic-API workers have a non-cancellable in-flight request. Flag it as an M1–M3 limitation (finding 01 §3.2).

- **m3 — Profileless/ad-hoc metered picks get no `baseUrl`/`auth`.** The resolver's parent-inherit tier returns `{kind, model, profileName}` only when an ancestor has a bare `backend_kind` (`SqlBackedBackendResolver.ts:54-56`); the plan's §5d threading is profile-centric (`rb.auth/baseUrl/params`). An explicit `backendKind:"openai"` pick with no named profile resolves to empty creds. Require metered selection to go through a named profile, or document the limitation.

- **m4 — Keep Anthropic *thinking* OFF until M4.** The `preserve-signed` round-trip carrier (`ModelTurn.providerMetadata` + a `ModelMessage` signed block) lands in M4, but the §7.1 `anthropic-billed` example already declares `reasoningRoundTrip:"preserve-signed"`. If anyone enables `params.thinking` on that profile before M4, multi-turn tool loops 400 (`toAnthropicMessage` drops thinking, `AnthropicModelClient.ts:69-73`). Add an explicit "do not enable thinking on the Anthropic API lane before M4" guard/note.

- **m5 — No provider-error observability.** A round-trip 400, a keyless-localhost connection refusal, or a missing-price billed turn collapse into a generic `turn:error` / silent default. For a metered, multi-provider lane, add a typed event or structured log for these so misconfig is diagnosable (the directive's "observability/events" structure).

- **m6 — The conformance pass is shallow; don't lean on it as evidence the lane "works."** §1/§3.1 cite "passes the backend conformance suite" as proof the seam is sound. The suite is 5 universal invariants with a fake model and scripted turns (finding 01 §2.5) — it proves adapter *shape*, not lifecycle/tools/prompt/billing. Reword §1 so it doesn't imply end-to-end readiness, and ensure the new "full-lifecycle integration" test (§9) actually runs a real (localhost-stub) model with a real system prompt + real built-ins.

---

## Genuinely sound (one line each — no padding)

- **Two wire dialects + capability-not-kind extension.** Well-grounded; `BackendProfile`-as-unit-of-selection reuses the existing `modelSource:"profile"` split correctly; no kind-branch introduced.
- **The `updatedInput`/rewrite gate fix (Q0, §5e).** Correct and minimal — `sdkPolicy` already returns `updatedInput` (`container.ts:731`), `PolicyDecider`/`PolicyDecision` already carry it (`SdkPermissionBridge.ts:10-20`), so the 2 edits (`ToolRuntime.ts:21-24` return type + `:127` apply; `PolicyToolGate.ts:16` propagate) restore parity with no branch. Land it first as stated.
- **Built-ins gated "for free" via canonical naming.** Verified: bare names + `command`/`file_path` fields hit the existing category sets (`permission-mode.ts:28-31`), 2-value `MODE_SPECS` (`:80-95`), and blocked-builtin deny (`tool-scope.ts:26,52`). The shared canonical-name enum (§5b) is the right mitigation for the silent-escape risk.
- **DPI immutable-`when` discipline.** Plan correctly refuses to add a `provider`/`backend` fact and drives lane-specific text through the assembly lane parameter; proposing the missing guard test (§9, §11) is the right call.
- **Key security.** Keychain-by-reference, raw key never in `config.json`/SQLite, operator-gated `POST /api/backends` — sound; `writeKeychainSecret` is correctly identified as net-new (no such fn exists today).
- **Back-compat.** All schema deltas are additive/optional; widening `sessionStore` with a non-shared `"eos-conversation"` value keeps `canHandoffBackend` correctly blocking cross-lane handoff.

---

## G1–G4 coverage checklist

| Goal | Status | Where delivered / precise gap |
|------|--------|-------------------------------|
| **G1** — any provider by key + local by localhost URL | **Partial** | Plumbing design (§5d, M1) is sound *once* per-worker `auth`/`baseUrl`/`params` threading lands. **Gaps:** baseUrl `/v1` convention undefined + example wrong (**MJ1**); cost defaults to Opus for unknown models (**MJ2**); no retry on 429/5xx (**MJ3**); small-context local models will 400 with no compaction (**MJ4**); profileless metered picks get no creds (**m3**); models lacking native tool-calling are explicitly out of scope (§2.2) — so "ANY provider" is qualified. |
| **G2** — full SDK/CLI feature set (built-ins, MCP, skills) | **Not delivered as specified** | Built-ins (M2-plan) and MCP (M5-plan) are well-designed. **Blocked by B1:** with no system prompt the agent "has the MCP tools but ignores them" (`ClaudeSdkBackend.ts:73-77`). `Task` is hand-waved (**MJ5**). Skills rest on the missing prompt slot + lack resource handling and auto-trigger (**MJ6**). No context compaction the SDK/CLI get free (**MJ4**). |
| **G3** — any model on orchestrator + all worker scopes, in sync, surviving restart | **Partial** | `backendProfile` field + resolver precedence (§5d) correctly enable all scopes + inheritance; orchestrator path is least-gapped. **Gaps:** a project/user worker's *instructions* (`def.body`→DPI) never reach the model (**B1**) → not "the same agent" across lanes; restart durability seam under-specified (**MJ7**); cross-provider cost is wrong until the pricing fix (**MJ2**) lands. |
| **G4** — modular, configurable, SOLID | **Mostly, with a hole** | Extension points are real (config entry / registry entry, no new class) and the capability-not-kind discipline holds. **But** "no structure missing" fails on B1 (DPI slot absent), the declared-but-unused `contextWindow` (**MJ4**), the unspecified durability injection seam (**MJ7**), and the hand-waved `Task` (**MJ5**). The proposed DPI-immutable-`when` guard test (§9) correctly closes the one guard gap the architect flagged. |

*Bottom line: the architecture is right and most dimensions are carefully designed,
but the plan ships a metered worker that has tools and no instructions (B1), bills it
at the wrong price (MJ2), can't survive a rate limit (MJ3) or a small context (MJ4), and
hand-waves two of G2's named surfaces (Task MJ5, skills MJ6). None are unfixable — but
none are optional for the "flawless / complete" bar the user set.*

---

## Re-review (round 2)

> Focused re-review of the architect's revision (§5h, §12, the per-MAJOR sections).
> Re-verified the load-bearing code claims the fixes rely on, not just the prose.

### FINAL VERDICT: **implementation-ready.** 0 remaining BLOCKER · 0 remaining MAJOR. The BLOCKER and all 7 MAJORs are closed as concrete, code-verified design; 2 new MINOR residuals + the D8 decision noted below — none gate implementation.

### Per-finding

- **B1 — RESOLVED.** Verified the mechanism is real, not asserted: `assembleAppendFor(spec, id, backendKind)` (container.ts:668) builds the DPI text *lane-independently* — the worker-definition body becomes a `role/20` fragment (container.ts:611-623), so a project/user worker's instructions genuinely reach the model — and the `backendKind` arg drives *only* `selectInjectableMemory` (container.ts:674), which drops sources whose `assumeNativeFor` includes the lane. A new `"in-process"` value is native to nothing → **all** memory (CLAUDE.md/project/user) injects, correctly. The delivery target (`system`) exists on both clients (AnthropicModelClient.ts:23,37 / OpenAIModelClient.ts:22,37). Landed in M1 before tools/skills; M1 test gates on a non-empty `system`. The §12 conformance reframing (m6) is also done. (Residual → N1.)
- **MJ1 — RESOLVED.** Origin-only convention stated, normalized on the `POST /api/backends` write path, §7.1/§2.1 examples corrected to `http://localhost:11434` (no `/v1`), composed-URL assertion added (Q0b/M1).
- **MJ2 — RESOLVED.** `priceFor` unknown-model fallback → loud known-zero + warning (Q0c), and a price is *required* for every `costMode:"billed"` profile at load/`POST /api/backends`, so the Opus-default (container.ts:242) can never bill a metered turn.
- **MJ3 — RESOLVED.** `withRetry` (bounded backoff, honors `Retry-After`, 429/500/502/503/529) inside both clients, distinct from the turn-ending hard error; M4. M1–M3 limitation documented.
- **MJ4 — RESOLVED.** `contextWindow` now has consumers: an M1 fail-fast pre-flight guard (typed `context_window_exceeded`) and an M4 `ContextCompactor` port injected into the loop deps (§6, §11), both reading `capabilities.contextWindow`, with tests. No longer declared-but-unused. (Compaction caveat → D8 below.)
- **MJ5 — RESOLVED.** `Task` is now a concrete closure: child surface without control tools, child DPI prompt via `assembleAppendFor(childSpec, "in-process")` with `subagent_type`→a built-in worker def, child `emit` re-tag via `parentCallId` (verified real, canonical.ts:49, "subagent attribution"), depth cap, shared `signal`, `agentId` rung-0.5 gate isolation. (Wiring nit → N2.)
- **MJ6 — RESOLVED.** Metadata injection now targets the §5h slot that B1 creates (the dependency is explicit and sequenced: M6 after M1); `SkillCatalog.loadBody → {body, dir}` gives `Bash`/`Read` skill-resource access; `SkillBlock` surfacing verified (canonical.ts:63-67); G2 honestly scoped to discovery + metadata + manual-invoke (auto-trigger is the one stated cut).
- **MJ7 — RESOLVED.** `createInProcessBackend(kind, envFactory, {store, ids})` (optional 3rd arg → conformance unaffected); `IdGenerator.newSessionId()` is a clean idiomatic addition (the port already has five `newXId()` methods, IdGenerator.ts:5-11); save at the existing `kickTurn` `.then`; resume via `store.load`. The `attach` hazard is correctly re-scoped — `isAlive()` already returns `live.has(workerId)`→false (honest), resume goes through `start` not `attach`, with optional lazy-rehydrate as the robust option. My round-1 "looks valid" was an overstatement; the plan's nuance is the accurate read.
- **m1–m6 — all RESOLVED** (kind-aware `sessionFor` CAPS; documented Anthropic mid-request/no-retry/no-compaction M1 limitations; named-profile requirement for metered picks; the ⚠ thinking-off-until-M4 note on the example profile; typed `provider:error` observability; conformance reframed to shape-only).

### New findings (round 2)

- **[MINOR] N1 — B1 delivers the prompt; behavioral *sufficiency* vs the `claude_code` base harness is asserted, not yet proven.** Unlike the SDK lane (`systemPrompt: {preset:"claude_code", append}`, ClaudeSdkBackend.ts:305), the in-process `system` has no base preset — it is the DPI append alone. The Eos *operational* protocol (reporting, `mcp__worker__*` usage) IS in that append, so the "has tools but ignores them" failure is genuinely closed; the residual is base-model framing (tone/generic tool etiquette) `claude_code` normally supplies. The plan flags this (§5h step 3) with a remedy (a `lane/in-process` base fragment via the assembly `extra` path), but conditions it on "if validation surfaces a gap," and the M1 test only checks `system` is non-empty — not sufficiency. *Fix:* make the M1 acceptance explicitly compare API-lane vs SDK-lane behavior on a real task, and pre-author the `lane/in-process` base fragment rather than waiting for a gap. Non-blocking; matters most for the `anthropic-api` (raw-Claude-API) profile.
- **[MINOR] N2 — `Task` closure ↔ `buildLaneTooling` sync/creds coherence.** §5e builds the `Task` closure "over the env-factory ingredients" (resolved creds + dialect builder), but §5d/§10 insist `buildLaneTooling` stays **sync** and it takes only `spec` today (container.ts:743). Resolved creds come from the `await authResolver.resolve` in the async factory. *Fix (one line in §5e):* state that `buildLaneTooling` is either called within the async-factory scope after cred resolution, or receives the resolved creds + dialect-client builder as params — so the `Task` child can build its model client. Feasible; just under-specified.

### D8 assessment (new decision — context compaction strategy)

**Sound and genuinely non-blocking.** The `ContextCompactor.compact(messages, capabilities)` port is implementation-agnostic, so drop-oldest vs summarize is purely an M4 internal — it changes no contract/port and the M1 fail-fast guard ships regardless. The recommended default (drop-oldest + retained summary marker for v1; summarize as a per-profile opt-in) is the right call on a metered lane where an extra summarization round-trip is real cost/latency. **One caution for the M4 implementer (not a plan defect):** compaction must drop tool turns at *matched-pair* granularity — an orphaned `tool_use` without its `tool_result` (or vice-versa) is itself a 400 on Anthropic. The plan's "drop oldest *tool turns*" phrasing implies turn-granular dropping, which preserves pairing if implemented faithfully; worth an explicit assertion in the M4 compaction test.

### Regression / soundness checks

- **Roadmap (re-sequenced B1→M1): dependency-sound.** M2 (`Task`/built-ins) and M6 (skill metadata) correctly depend on M1's §5h prompt slot; the stated ordering invariant ("nothing that depends on worker instructions ships before B1") holds. M1 is now heavy (B1 + contracts + threading + enablement + Q0 + pricing + context guard + kind-aware caps) but internally coherent and the critical path is B1 — not mis-sized, not secretly blocked.
- **§12 cross-references real.** §5h, Q0a–c (lines 473-475), D8 (560), and the G1–G4 closure table all exist and resolve.
- **No finding-closure opened a new BLOCKER/MAJOR.** B1's synthetic `"in-process"` lane value is safe (selectInjectableMemory treats an unknown lane as "inject all" — verified). The two new items are MINOR.
- **G1–G4 genuinely close** (with the two explicit, reasonable v1 cuts named in-plan: no-native-tool-calling models out of scope (G1), skill auto-trigger out of scope (G2)).
