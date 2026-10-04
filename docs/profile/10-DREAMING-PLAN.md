# Dreaming — implementation plan

Design-only spec. Designs: canvas "Eos Dreaming"
(https://claude.ai/artifact/BBJiE91mbVVjELVDWTPtjp) — **A · Journal** (morning digest on
top of Memory) + **B · Triage** (one-at-a-time review) are the chosen directions;
building blocks: proposal types, Settings › Dreaming, live states, Dream log.
Builds on `00-PROFILE-PLAN.md` (P0–P5 shipped).

## What it is

While the user is away, Eos rereads finished chats, turns what it learned about the user
into memory **proposals**, and greets them with a morning review. Nothing changes without
the user's OK. Decisions (confirmed): review = A + B · default schedule = **every night**
(03:00, or the next time the Mac is awake) · default model = **Opus** (`opus` alias).

## Proposals

| Kind | Meaning | Keep does |
|---|---|---|
| `new` | something said/shown that agents don't know | suggestion → active |
| `update` | a kept memory drifted | target.text ← proposal text; suggestion removed |
| `merge` | 2+ kept memories overlap | suggestion → active; targets removed |
| `promote` | a project memory holds everywhere | target.scope ← global; suggestion removed |
| `retire` | a kept memory is no longer true | target removed; suggestion removed |

A missing target at keep time ⇒ 409 "the memory it changes is gone" (user dismisses).

**Quality bar** (prompted + enforced in code where possible): durable (not one task's
detail) · user-originated (not the agent's opinion) · actionable for a future agent · not
already known (profile, CLAUDE.md, active/suggested memories) · not previously
**dismissed** · no secrets (pattern scrub, code-enforced) · evidence = ≥1 explicit statement
or ≥2 occurrences · confidence 1–3. Every proposal carries evidence quotes (worker id,
event id, who said it) so the UI can link to the exact message.

**Learns from the user:** dismissing keeps the memory as a `dismissed` tombstone (hidden
everywhere, never rendered) — dedupe for every producer (agents and dreams) checks it, so a
dismissed idea never comes back. An agent re-suggesting it gets "the user declined this before".

## Pipeline (one run)

1. **Guards** — enabled (or manual) · Claude **sign-in** present (never bills an API key) ·
   plan usage `max(fiveHour, sevenDay) < usageCeiling` · not already running.
2. **Collect** — root sessions (top-level chats; that's where the user talks) not WORKING,
   with events after their watermark; skip excluded projects / excluded chats / no-folder
   chats when off; newest first, cap `maxChats`.
3. **Recall** (per chat) — transcript rendered lane-neutrally (user turns full, agent turns
   trimmed, each line tagged `[e<eventId>]`, char budget) → `ConversationSummarizer` with
   `prompts/dream/recall-*` → JSON observations `{ statement, kind, scopeHint, evidence:[eventId] }`.
   Between chats: stop if asked or the user came back (a new user message since start).
4. **Consolidate** (once) — all observations + memories (active, suggested, dismissed) + a
   profile digest → `prompts/dream/consolidate-*` → JSON proposals + a one-paragraph
   narrative + dropped counts by reason. Parsed with zod; targets must exist; invalid ⇒ dropped.
5. **File** — each proposal → `UserMemorySuggestionSink.suggest(…, { kind: "dream", dreamId,
   evidence })` (dedupe + tombstones + cap apply). Watermarks advance only for chats read.
6. **Record** — run row (stats, narrative, dropped, chats) · `dream:change` SSE · one
   morning banner ("Eos dreamt · N to review", route `memory`) when proposals exist and
   `morningNote` is on. Agent-suggestion banner skips dream-created memories.

Token use is estimated (chars/4) for the log; the summarizer returns text only.

## Contracts

- `contracts/src/dream.ts` (new): `DreamingSettingsSchema` (enabled=false, schedule
  `nightly|away|manual`=nightly, nightlyAt "03:00", awayMinutes 20, model `opus|sonnet|haiku`=opus,
  maxChats 20 (1–60), usageCeiling 0.7, excludedProjects [], includeNoFolder true,
  morningNote true) · `DreamEvidenceSchema` · `DreamRecallOutputSchema` ·
  `DreamConsolidateOutputSchema` · `DreamRunSchema` / detail / status / `DreamChangeEvent`.
- `profile.ts`: `UserProfile.dreaming` (`.default(...)` so existing profile.json loads) +
  patch · `UserMemoryStatus` += `dismissed` · `UserMemory.proposal?` `{ kind, targets, confidence }`
  · `UserMemorySource` += `{ kind: "dream", dreamId, evidence[] }` · change event `by` += `dream`.
- ROUTES: `dreams` (GET list / POST dream now), `dream(id)`, `dreamStatus`, `dreamStop`,
  `dreamExclusions` (POST {workerId, excluded}). Writes ui-token gated.

## Core

- `domain/dream.ts` (pure): `isNightlyDue(now, settings, lastRunAt, tzOffset)`,
  `renderChatForDream(messages, budget)`, `scrubSecrets`/`looksSecret`, `parseRecall`,
  `parseConsolidation(json, memories)` (target + type validation), `dreamSummaryLine`.
- `domain/message-normalize.ts`: export `normalizeEventRow` (keeps callers unchanged) so
  the dream renderer can keep event ids.
- `ports/DreamRepo.ts`: runs (start/finish/list/get), watermarks, chat exclusions.
- `use-cases/DreamOverChats.ts`: steps 1–6 over ports (`summarizer`, `events`, `workers`,
  `memories` sink + reader, `repo`, `profile`, `prompts`, `clock`, `bus`, `canDream`,
  `usageOk`, `shouldStop`).
- `UserMemoryService`: proposals + kind-aware `approve`, `dismiss` → tombstone, dedupe vs
  tombstones, `suggest` result `{ memory, duplicate, declined }`.

## Infra / manager

- `infra/src/persistence/SqliteDreamRepo.ts` + migration `061_dreams`
  (`dream_runs`, `dream_watermarks`, `dream_exclusions`) — regenerable log, `--db` may wipe it.
- `manager/services/DreamService.ts`: 60 s tick → nightly/away due check; `dreamNow()`,
  `stop()`, `status()` (running + progress); one run at a time; publishes `dream:change`.
- Prompts `manager/prompts/dream/{recall-system,recall,consolidate-system,consolidate}.prompt.md`.
- Routes `manager/routes/dreams.ts`; container wiring; daemon start/stop.

## UI

- **Settings › Profile › Learning** — `DreamingRow` becomes live (`settings/profile/DreamingGroup.jsx`):
  toggle · When (Every night / While I'm away / Only when I ask) + time · Look at (project
  chips + No-folder) · Reads with (Opus default) · up to N chats · usage ceiling · morning
  note · last dream line + Dream now + Dream log.
- **A · Journal** — `views/memory/DreamJournal.jsx` atop MemoryView while the latest run has
  pending dream proposals: narrative, kind chips, proposal rows (Keep/Edit/Dismiss), Keep the
  rest, "Review one by one", Dream log. Generic agent suggestions stay in SuggestionInbox.
- **B · Triage** — `components/profile/DreamReview.jsx` full-window: K keep · E edit · D
  dismiss · → later; evidence panel (quotes → open chat), confidence, why.
- **Live** — Memory rail Dreaming card (on/off, next run, Dream now); dreaming-now card with
  progress + Stop; account menu "Dreamt tonight · N to review"; avatar pending dot violet for
  dream proposals; quiet states (nothing new, held off, sign-in needed).
- **Dream log** — `views/memory/DreamLog.jsx` (Memory sub-view): runs list, run detail
  (stats, chats read with "dream about it" switch, decisions, dropped by reason).
- Shared: `lib/dreamProposals.js` (kind meta, labels, outcome text) — pure, tested.

## Phases (green each: lint + package tests; never `eos build`/`restart`)

Status: **D0–D2 implemented** (2026-10-04). Notes from building it:
- Dismiss is now a tombstone everywhere (agents get "declined before" too); the list
  route hides tombstones unless `?status=dismissed`.
- Dream proposals store `proposal.kind = "new"` too (so the review can show confidence);
  keeping one strips the proposal.
- First sight of Dreaming on with no runs yet (or switching it on) waits for the next
  slot — enabling it in the afternoon never dreams at once.
- Account-menu "Dreamt · N to review" opens the review (B) directly; the avatar dot is
  violet for dream proposals, accent for agent suggestions.

| Phase | Scope |
|---|---|
| D0 | contracts + core domain (pure) + tombstones/proposals in UserMemoryService |
| D1 | dream engine: repo + migration, use-case, prompts, DreamService, routes, SSE, banner |
| D2 | UI: Settings group, Journal (A), Triage (B), live states, Dream log |

## Risks

- **Wrong memories** — Opus default, strict bar, evidence required, user approves each.
- **Cost** — plan-only, usage ceiling, chat cap, char budget, nightly by default.
- **Privacy** — excluded projects/chats never read; secrets scrubbed before any prompt and
  rejected in proposals; everything stays on this Mac except the summarizer call itself.
- **Prompt injection from transcripts** — transcript fenced as data in the recall prompt;
  proposals are suggestions only; approval gate.
