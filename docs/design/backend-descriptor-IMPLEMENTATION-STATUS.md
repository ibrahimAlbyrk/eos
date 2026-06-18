# BackendDescriptor implementation — status & resume handoff

**Date:** 2026-06-18. **Purpose:** survive a conversation compaction. Resume from here.
**Design report (the "why"):** `docs/design/backend-descriptor-provider-metadata.md`.
**Goal:** kill the scattered hardcoded `kind === "claude-cli" / "claude-sdk"` checks by giving each provider a `BackendDescriptor` (data); every consumer reads a descriptor property instead of comparing kind literals. Tracked as tasks P1–P4.

**Wider context (all DONE + green, uncommitted):** the agent-backend unification A/B/C/D/E(a)/F + SPIKE (passed) + FLIP (claude-sdk is the default) + the provider-UX rework (Settings→Provider = kind picker, model from composer). This descriptor work is the post-review cleanup the maintainer requested. Baseline green counts: contracts 34 · manager 705 · infra 176 · app/ui 698 · lint 0 errors. **Nothing is committed** (maintainer reviews the working tree).

---

## DONE

### P1 — BackendDescriptor defined + populated (COMPLETE, gated green)
- `core/src/ports/AgentBackend.ts`: added `ModelCatalogRef` (`{kind:"claude"} | {kind:"static",models} | {kind:"openai-compatible"}`) + `BackendDescriptor { kind, label, processModel:"in-process"|"out-of-process", billing:"subscription"|"metered", modelSource:"request"|"profile", capabilities:AgentCapabilities, models:ModelCatalogRef, auth:"subscription"|"apikey"|"none", enabled }`. Added `readonly descriptor: BackendDescriptor` to `AgentBackend`, and `descriptors(): BackendDescriptor[]` to `AgentBackendRegistry`. (descriptor.kind is `string` so the "fake" adapter fits.)
- Adapters now expose a descriptor: `manager/backends/ClaudeCliBackend.ts` (CLI_DESCRIPTOR: out-of-process/subscription/request/claude), `manager/backends/sdk/ClaudeSdkBackend.ts` (SDK_DESCRIPTOR: in-process/subscription/request/claude), `infra/src/backends/InProcessBackend.ts` (IN_PROCESS_DESCRIPTORS map for anthropic-api/openai/codex → metered/profile + a factory fallback), `infra/src/backends/FakeAgentBackend.ts` (FAKE_DESCRIPTOR).
- `manager/container.ts`: the `backends` registry object gained `descriptors() { return [...backendMap.values()].map(b => b.descriptor); }`.

### P2a — process-model checks → descriptor (DONE, gated green)
Replaced `kind !== "claude-cli"` (is-inproc) + handle-build with `descriptor.processModel`:
- `core/src/use-cases/DispatchMessage.ts:91-94`: `const backend = deps.backends?.has(kind) ? deps.backends.get(kind) : undefined; const isInproc = backend?.descriptor.processModel === "in-process";`.
- `manager/routes/dispatch-deps.ts:26`, `manager/routes/resume-helpers.ts:23`, `manager/commands/handlers/interrupt-worker.ts`: descriptor.processModel.
- **Regression fixed:** `core/src/__tests__/DispatchMessage.test.ts` `fakeBackend` had no `descriptor` → `backend?.descriptor.processModel` threw (6 fails). Added `descriptor = { processModel: kind === "inproc" ? "in-process" : "out-of-process" }` to the fake. (Lesson: `npm test | tail` masks npm's exit code — the false "exit 0" hid this. Always capture EXIT separately.)

### P2b — billing checks → descriptor (DONE, gated green)
- `core/src/domain/backend-billing.ts`: now `isMeteredBackend(d: BackendDescriptor) => d.billing === "metered"` + `meteredNeedsBilledIntent(d: BackendDescriptor, rb: ResolvedBackend) => isMeteredBackend(d) && rb.costMode !== "billed"`. `SUBSCRIPTION_KINDS` deleted.
- `core/src/__tests__/backend-billing.test.ts`: rewritten to pass descriptors.
- `manager/commands/handlers/spawn-worker.ts` + `manager/routes/orchestrators.ts`: `const backend` moved ABOVE the guard; `meteredNeedsBilledIntent(backend.descriptor, rb)`.

### P2c — model-source checks → descriptor (DONE, gated green)
- spawn-worker.ts + orchestrators.ts: model line → `backend.descriptor.modelSource === "profile" ? rb.model : …`.

### P2d — explicitKind + creds-fallback → descriptor (DONE, gated green)
- `core/src/services/SqlBackedBackendResolver.ts`: explicit-kind branch removed (resolver test never exercised explicitKind, so untouched). `explicitKind` kept on `ResolveBackendInput` (manager helper owns it).
- `manager/shared/spawn-backend.ts`: rewritten — explicit pick reads the descriptor (`kind`+billing→costMode); creds fallback is data-derived (`descriptor.auth==="subscription" && processModel==="in-process"` + `authResolver` `scheme:"none"` → first `billing:"subscription", processModel:"out-of-process"` descriptor).

**Gate after P2 (b/c/d + P2a fix): manager 705/705 pass · lint 0 errors.** contracts/infra/app-ui untouched by P2.

---

## DONE (cont.)

### P3 — surface descriptors to the UI (DONE, gated green)
- `contracts/src/http.ts`: added `UiBackendDescriptorSchema` (kind/label/enabled/billing/capabilities) + `backends: z.array(...).default([])` on `UiConfigResponseSchema`.
- `manager/routes/uiConfig.ts`: returns `c.backends.descriptors().map(...)` (the UI subset).
- `app/ui/src/lib/backendCaps.js`: REWRITTEN descriptor-driven — module-level `DESCRIPTORS` map + `applyDescriptors(list)` (mirrors `models.js`/`applyCatalog`) + `providerOptions()`; `backendCaps`/`backendBilled` read the map (PTY-permissive / not-billed fallback when unloaded). `SUBSCRIPTION_KINDS` + PTY/STRUCTURED literals gone.
- `app/ui/src/hooks/useLive.js`: `applyDescriptors(cfg?.backends)` next to `applyCatalog` on ui-config load.
- `app/ui/src/settings/registry.jsx`: Provider dropdown `options` is now a getter → `providerOptions()` (enabled descriptors; no hardcoded 2-item list). `defaultValue:"claude-sdk"` kept (a default must be concrete; mirrors config).
- Tests updated: `backendCaps.test.js` (descriptor-driven + fallback + providerOptions), `registry.test.js` (descriptor-driven provider options, disabled excluded).
- **Deferred (Simplicity First — no consumer yet):** provider-aware model *catalog filtering*. Both current providers are Claude (same catalog); `ModelCatalogRef` lives on the core descriptor for when a non-Claude provider is added, but no UI filtering logic was built speculatively. The composer model picker already serves both.

### P4 — regression guard (DONE, gated green)
- `manager/backends/__tests__/backend-kind-literal-guard.test.ts`: scans `contracts/core/infra/gateway/spawner/manager/app-ui` source for `=== "claude-cli"/"claude-sdk"`-style COMPARISONS (either order; single `=` assignment/identity not matched) and fails with `file:line`. Verified with a planted probe (caught it, then removed). Identity/backfill/enum/config (no comparison operator) are intentionally allowed.

**Final gate (P1–P4): contracts 34 · manager 706 · infra 176 · app/ui 699 · lint 0 errors.**

**Net result:** ZERO backend-kind comparison checks remain in non-test source (verified by grep + the P4 guard). Every consumer now branches on `BackendDescriptor` data (processModel / billing / modelSource / capabilities). Adding a provider = one descriptor + adapter, no consumer edits.

---

## Leave-alone literals (NOT smells — do not "fix")
- `?? "claude-cli"` null-backfill defaults: `DispatchMessage.ts:91`, `SpawnWorker.ts:243`, `resume-helpers.ts:14`, `interrupt-worker.ts:18`, `SqliteWorkerRepo.ts:94`, `SqlBackedBackendResolver.ts` global-default. These mean "a row with no tracked backend_kind was created before we tracked it = claude-cli" (migration 022 backfill). Historical data default, won't change. (Optional: centralize into one `DEFAULT_BACKEND_KIND` constant — low priority.)
- Each adapter's own `kind: "claude-cli"/"claude-sdk"/"fake"` + descriptor.kind (identity).
- `container.ts` backendMap registration keys + the `BackendKind` enum.

## Gate (run after each P2/P3 sub-step)
```
(cd contracts && npm test) ; (cd manager && npm test) ; (cd infra && npm test) ; (cd app/ui && npm test) ; npm run lint   # root
```
Targets: contracts 34 · manager 706 · infra 176 · app/ui 699 · lint 0 errors. **Capture EXIT separately — `npm test | tail` masks npm's exit code.** **P1–P4 ALL DONE & green (uncommitted, awaiting maintainer review).**
