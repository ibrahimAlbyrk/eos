# Profile & Memory — implementation plan

Design-only. Spec an implementer follows. Designs: canvas "Eos Profile"
(https://claude.ai/artifact/BytktwGMk5adom74Go9iD8) — **A · Dossier** = Settings ›
Profile, **B · Memory Atlas** = Memory view, **C · Interview** = first run, **Entry** =
sidebar row + account menu.

## Goal

Agents start every task knowing who the user is. Three things, one write path each:

1. **Profile** — structured identity + working style the user edits (A, C).
2. **Memories** — discrete facts, each with scope (global / project), tier (always-on /
   on-demand), source (user / agent / import). Agents *suggest*, only the user *keeps* (B).
3. **Injection** — one pure renderer turns profile + always-on memories into a
   token-budgeted `<user_profile>` block at spawn; on-demand memories are fetched by tool.

Non-goals (v1): profile sync across paired Macs, public profile/stats page (canvas D),
usage heatmaps, cloud storage.

## Current state (verified)

- Hardcoded `<user_preferences>` ("Be as concise and direct…") in BOTH preambles:
  `manager/prompts/system-preamble-worker.prompt.md`, `system-preamble-orchestrator.prompt.md`.
  This is what the profile replaces.
- Spawn chokepoint: `assembleAppendText(spec, id, lane)` (`manager/container.ts:~700`) →
  `assembleSystemPrompt` (`core/src/use-cases/AssembleSystemPrompt.ts`); wrapped by
  `assembleAppendFor(spec, id, backendKind)` (`container.ts:~801`) which appends CLAUDE.md
  via `MemoryProvider` + `composeAppendedPrompt` (`core/src/services/compose-appended-prompt.ts`).
  Pre-rendered variables (`MODEL_TIER_TABLE` pattern) are **not re-parsed** → safe for user text.
  Synthetic fragments ARE parsed (`{{` in user text silently drops the fragment) → never use them.
- Prompt is computed once per lane `start()` and reused on `/clear` and compaction restarts
  (SDK `baseOptions.systemPrompt`, Codex `developerInstructions`, Gemini first prompt).
  ⇒ profile edits reach **new/resumed** sessions, not running ones.
- `~/.claude/CLAUDE.md` already reaches EVERY lane: the claude lane loads it natively
  (`settingSources:["user","project"]`); Codex/Gemini/in-process get it injected by
  `MemoryProvider` (`config.memory.sources.claude`, `assumeNativeFor:["claude"]`,
  `manager/shared/config.ts:383-396`). It stays the user's Claude Code file — Eos never writes it.
- Template for a user-data domain: `PageService` + `PageStore` port + `FilePageStore`
  (atomic tmp+rename, Map cache, `.trash/`), `pages:change` on `EventBus`, 409 `StalePageError`.
- Agent identity on routes: `x-eos-agent-id` (declared, not authenticated) → `callerOf()`.
  Privileged routes: `uiTokenOk` (`manager/routes/fs-shared.ts:40`), accounts pattern `denied()`.
- Eos MCP tools are auto-allowed on every lane; Task subagents are denied them.
- One-shot model call with custom system prompt: `ConversationSummarizer` port
  (`SdkSummarizer`, needs a Claude credential). IDLE edge: `manager/daemon.ts:256-304`.
- **Name collisions to avoid:** `Memory*Schema`, `ROUTES.workerMemory`, `config.memory`,
  `ProjectMemoryStore`, `MemoryProvider` all mean *Claude Code file memory / CLAUDE.md*.
  New code uses **`UserProfile*`** and **`UserMemory*`**; UI copy says "Memory".
- CLAUDE.md is stale (claude-cli lane, `spawner/worker.ts`, `auto-allow.sh`, the
  `backend-kind-literal-guard` test were removed in `368cc14f`). Fix separately.

## Decisions (confirmed)

| # | Decision | Choice |
|---|---|---|
| D1 | Storage | Files under `~/.eos/profile/` (user data, survives `restart --db`): `profile.json`, `avatar.<ext>`, `memories/<id>.md`. Telemetry (reads) in state.db (regenerable). |
| D2 | Standing instructions | **Eos-owned** `profile.instructions`, rendered by the same renderer into every lane's `<user_profile>` block. CLAUDE.md is never written. "Import from CLAUDE.md" = read-only copy of the user-level file into the box for the user to edit. Lines the session already receives from CLAUDE.md are dropped at render time (`dropKnownLines`) so import never doubles a rule. |
| D3 | Injection site | Replace both hardcoded `<user_preferences>` blocks with `{{USER_PROFILE}}`, rendered in core, passed via `SessionSpawnContext` (variable = not re-parsed, keeps position, preview tools see it). Empty profile ⇒ renders today's exact default text ⇒ byte-identical prompts for users without a profile. |
| D4 | Project scope key | Absolute folder path, worktrees resolved to source repo (same as pages `sessionProjectOf` / `memoryDirFor`). |
| D5 | Sharing per provider | `profile.sharing.withholdFrom: string[]` of backend kinds — data, like `assumeNativeFor`; no code branches on kind. UI groups kinds by account provider. Withheld lane ⇒ default text + memory tools refuse. |
| D6 | Background extraction = **Dreaming** | Not built now. v1 suggestions come only from the `suggest_memory` tool. Settings › Profile › Memory shows a **Dreaming** row with a "Soon" badge and a disabled, off switch (same row in the Memory view rail). The suggestion pipeline is producer-agnostic so Dreaming plugs in later with no storage/UI/approval changes — see "Future: Dreaming". |
| D7 | Memory view location | Main-area takeover in Agents view (Archive pattern). Entry points: avatar pending dot → account menu ("Agents noticed N things · Review", "Memory"), Settings › Profile › Memories, the notification. No sidebar NavRow — keeps the calm sidebar from `3d685e51`. |
| D8 | Approval authority | Only ui-token routes keep/edit/delete. Agents can create `suggested` only. |

## Domain model — `contracts/src/profile.ts` (new, barrel-exported)

```ts
UserProfileSchema = z.object({
  rev: z.number().int(), updatedAt: z.number(),
  identity: z.object({ fullName: str(120), callName: str(60), handle: str(40).optional(),
                       avatar: z.string().nullable() }),              // file name in profile dir
  language: z.object({ chat: z.string(), code: z.string() }),         // BCP-47 or "mirror"
  work: z.object({ roles: z.array(RoleSchema), stack: z.array(str(40)).max(40),
                   level: z.enum(["learning", "practitioner", "expert"]) }),
  style: z.object({ replies: z.enum(["terse", "balanced", "thorough"]),
                    autonomy: z.enum(["ask", "balanced", "run"]),
                    whenUnclear: z.enum(["ask", "decide"]),
                    commits: z.enum(["on-request", "milestones"]) }),
  instructions: z.string().max(4000),                                 // D2, Eos-owned
  sharing: z.object({ withholdFrom: z.array(z.string()) }),
  budgetTokens: z.number().int().min(200).max(4000),                  // always-on budget, default 800
  onboardedAt: z.number().nullable(),
});
UserProfilePatchSchema = deepPartial(UserProfile minus rev/updatedAt) + { baseRev? }

UserMemorySchema = z.object({
  id: z.string().regex(/^um-[a-z0-9]{8,32}$/),
  text: z.string().min(1).max(500),
  category: z.enum(["about", "work-style", "stack", "project", "other"]),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("global") }),
    z.object({ kind: z.literal("project"), path: z.string() }) ]),
  tier: z.enum(["always", "on-demand"]),
  status: z.enum(["active", "suggested"]),          // dismiss = soft delete
  source: UserMemorySourceSchema,                   // discriminated union, open for new producers
  rev: z.number().int(), createdAt: z.number(), updatedAt: z.number(),
});
UserMemorySourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  z.object({ kind: z.literal("agent"), agentId: z.string(), agentName: z.string(), why: z.string().optional() }),
  z.object({ kind: z.literal("import"), from: z.string() }),
  // Dreaming adds { kind: "dream", workerIds, at } here — additive, no file migration.
]);
```

Plus request/response schemas, `UserProfileChangeEventSchema`, `UserMemoryChangeEventSchema`
(`{ id, action: created|updated|approved|dismissed|deleted, status, by }`).

**ROUTES** (`contracts/src/http.ts`, add to `routes.test.ts` `EXPECTED_KEYS`):

| Route | Method | Caller | Gate |
|---|---|---|---|
| `/api/profile` | GET | UI | — |
| `/api/profile` | PUT `{patch, baseRev}` | UI | ui-token; 409 + current on stale rev |
| `/api/profile/preview?kind=&project=` | GET | UI | — · returns `{ text, tokens, includedMemoryIds, overflow }` from the SAME core renderer |
| `/api/profile/avatar` | GET `?v=rev` / PUT (octet-stream, ≤5 MB png/jpeg/webp) / DELETE | UI | write: ui-token |
| `/api/profile/import/claude-md` | GET | UI | ui-token · read-only: user-level CLAUDE.md text via `MemoryProvider` (D2) |
| `/api/user-memories?status=&project=&q=` | GET | UI | — |
| `/api/user-memories` | POST (user create) | UI | ui-token |
| `/api/user-memories/:id` | PUT / DELETE | UI | ui-token |
| `/api/user-memories/:id/approve` · `/dismiss`, `/api/user-memories/approve-all` | POST | UI | ui-token |
| `/api/user-memories/suggest` | POST | agent | any known worker via `x-eos-agent-id` (Task subagents can't reach Eos tools anyway); lane not withheld; per-agent pending cap |
| `/api/user-memories/search?q=&limit=` | GET | agent | same as suggest; logs reads |

Not in `LOCAL_ONLY_ROUTES` (a controlling Mac may view the host's profile, ui-token rules apply).

## Core (pure, zero Node) — SRP split

```
core/src/domain/user-profile.ts      defaults(), isEmpty(), applyPatch(profile, patch) → profile
core/src/domain/user-memory.ts       scopeMatches(mem, project), similarity(a,b) (token Jaccard),
                                     findDuplicate(text, pool), rankForQuery(mems, q, limit)
core/src/services/render-user-profile.ts
                                     renderUserProfile(profile, memories, { project, budgetTokens, knownLines })
                                       → { text, tokens, includedIds, overflow }
                                     dropKnownLines(text, knownLines) — normalized line match (D2)
core/src/ports/UserProfileStore.ts   get(): UserProfile | null; put(p): void
core/src/ports/UserMemoryStore.ts    list(): UserMemory[]; get(id); put(m); remove(id): boolean
core/src/services/UserProfileService.ts
core/src/services/UserMemoryService.ts
```

**`renderUserProfile`** (single source for prompt AND UI preview — DRY):
- Empty profile + no always-on memories ⇒ returns `DEFAULT_USER_PREFERENCES` (today's text, verbatim).
- Otherwise emits `<user_profile>` with: address line, work line, language line, style line
  (each phrase from a lookup table — OCP: a new style option = one table row), then the
  user's instructions minus `knownLines` (lines this session already gets from CLAUDE.md), then
  "Remembered about the user:" bullets (global + matching-project always-on, newest first),
  then `N more memories are available — call search_memory …` when anything overflows/on-demand.
- Budget: `estimateTokens` (`core/src/domain/compaction.ts`); structured lines + instructions
  are never dropped (UI warns when they alone exceed the budget); memories drop from the tail
  into `overflow` until under budget.
- Memory text is data: strip/escape `<`/`>` sequences that could close the block; one line per memory.

**`UserProfileService`** (deps: store, clock, bus.publish)
- `get()`, `update(patch, baseRev)` → `StaleProfileError extends ConflictError` (409 like pages),
  no-op patch ⇒ no rev bump, emits `profile:change`.

**`UserMemoryService`** (deps: store, clock, bus.publish, newId)
- User side: `create`, `update`, `remove` (soft), `approve(id)`, `dismiss(id)`, `approveAll()`.
- Suggest side: `suggest(input, source)` — **producer-agnostic**: `source` is any
  `UserMemorySource` (today `agent`; later `dream`). `findDuplicate` vs active+suggested ⇒
  returns existing instead of creating; per-producer cap (default 5 pending) ⇒ `RateLimitError`.
  Dedupe, cap, approval, events and notifications live here once, for every producer.
- Read side: `forPrompt(project)`, `search(q, project, limit)`.
- ISP: export three narrow types the callers depend on —
  `UserMemoryReader` (prompt assembly, search route), `UserMemorySuggestionSink` (suggest route),
  `UserMemoryEditor` (ui routes). The service implements all three; nothing else sees the full class.

## Infra

- `infra/src/persistence/FileUserProfileStore.ts` — `profile.json`, zod-validated, atomic tmp+rename.
- `infra/src/persistence/FileUserMemoryStore.ts` — `memories/<id>.md` (YAML frontmatter + text),
  Map cache, `.trash/`. Extract the frontmatter serialize/parse + atomic-write helpers that
  `FilePageStore` already has into `infra/src/persistence/frontmatter-file.ts` and use them from
  both (DRY; FilePageStore behavior unchanged, its tests guard it).
- Avatar bytes: small adapter, write `avatar.<ext>` atomically, delete old.

## Manager

**Wiring (`container.ts`)** — construct stores/services next to `pages`; expose
`profile`, `userMemories` on the container. `user-data.ts`: add `"profile"`.

**Injection** — in `assembleAppendText` build the profile var once per spawn:
```ts
const project = sessionProjectFor(spec);                         // D4
const withheld = profile.sharing.withholdFrom.includes(kind);    // D5, data-driven
const knownLines = claudeMdLines(memoryProvider.load({ cwd, repoRoot }));   // unfiltered: claude lane loads it natively
const userProfile = withheld ? DEFAULT_USER_PREFERENCES
  : renderUserProfile(profile, userMemories.forPrompt(project), { project, budgetTokens, knownLines }).text;
```
`SessionSpawnContext.userProfile` → `sessionVars.USER_PROFILE`; both preambles:
`<user_preferences>…</user_preferences>` → `{{USER_PROFILE}}`. A focused session (no preamble)
gets it from `role/focused/01-user-profile` with the memory-tool section; an empty profile
renders nothing there, since focused never carried the stock preferences.
Also pass it in `scripts/preview-prompt.mts` and `POST /api/prompts/preview`.

**Routes** — `manager/routes/profile.ts` (`registerProfileRoutes`), `manager/routes/user-memories.ts`
(`registerUserMemoryRoutes`), registered in `daemon.ts` beside pages. Agent caller resolution:
`manager/routes/agent-caller.ts` (`agentCallerOf` → id, name, session project, backend kind);
withheld lanes get 403.

**MCP tools** (both surfaces, `manager/tools/defs/`):
- `search_memory({ query, limit? })` — on-demand + always-on for the session's project.
- `suggest_memory({ text, category, scope: "global" | "project", why })` — returns
  "Suggested; the user will review it." or the duplicate's text.
- Descriptions: `manager/prompts/tool/{search_memory,suggest_memory}.prompt.md`;
  names in `prompt-tool-names.ts`; registry + snapshot update.
- Role fragments `role/orchestrator/12c-memory.prompt.md` + `role/worker/10c-memory.prompt.md`
  (every role fragment lives under its role dir — dpi-parity enforces it):
  suggest when the user states a lasting preference/correction ("from now on…", repeated fixes);
  never suggest secrets, one-off task details, or things already in the profile; search when a
  task touches conventions you don't see in context.

**Notifications** — `manager/services/memory-suggest-notify.ts`: on `user-memory:change`
with `status: "suggested"`, debounce 30 s, fire one `notification:fire`
"Agents noticed N things" with `{ route: "memory" }`; `app/src/main/notifications.ts`
gains a `route` click target (today only `workerId`).

## UI (`app/ui/src`)

**State** (module singleton + `useSyncExternalStore`, like `accountsStore.js`):
- `state/profileStore.js` — `useProfile`, `ensureProfileLoaded`, `saveProfile(patch)`
  (optimistic; on 409 refetch, re-apply the user's changed fields, retry once).
- `state/userMemoryStore.js` — lists by status, `pendingCount`, approve/dismiss/edit/create.
- `hooks/useLive.js` — `profile:change` / `user-memory:change` → apply + `return`; resync both.
- `api/client.js` + `api/routes.js` — methods per route; writes send `uiTokenHeader()`.

**Shared components** (`components/profile/`):
- `ProfileAvatar.jsx` — photo (`/api/profile/avatar?v=rev`) or aurora orb + initials; sizes 16–116.
  Used by footer, menu, Settings, interview.
- `lib/profileText.js` — pure: initials, display name, subtitle. Tested.

**Entry (sidebar + menu)** — keep the one-row footer from `3d685e51` (machine row + 34 px
avatar-only button; do NOT bring back a name/subline). `SettingsFooter.jsx`: the placeholder
`.sb-settings__avatar` span becomes `<ProfileAvatar size={24}>`; dot priority on the avatar:
red `.sb-settings__alert` (expired sign-in, existing) > accent dot (pending memories, new
`--pending` modifier); tooltip gains "N memories to review". `AccountMenu.jsx`: profile header
(avatar, name, role · languages) → `openSettings("profile")`, or "Introduce yourself" card when
the profile is empty; suggestions row → Memory view; `Profile & memory` action.

**Settings › Profile (A)** — `settings/ProfileSettings.jsx` as a `Component` section at
index 0 of `SETTINGS_SECTIONS` (becomes the modal default — acceptable). Split into
`profile/IdentityGroup`, `LanguageGroup`, `WorkGroup`, `StyleGroup`, `InstructionsGroup`,
`MemoryGroup`, `SharingGroup`, `AgentPreview`. Each group = one concern, receives `{ value, onChange }`.
- `InstructionsGroup`: textarea bound to `profile.instructions` + "Import from CLAUDE.md"
  (GET `/api/profile/import/claude-md` → fills the box; nothing saved until the user saves).
- `MemoryGroup`: `DreamingRow` (moon icon, "Soon" badge, `<button disabled aria-pressed=false>`
  switch — static, no config behind it yet) + "Memories · N kept · M waiting" link to the Memory view.
  `components/profile/DreamingRow.jsx` is shared with the Memory view rail (DRY).
- New controls in `settings/controls.jsx` `CONTROLS`: `textarea` (save on blur), `chips`
  (single/multi pill select), `tags` (free-text list; extend `toolPicker` if it fits),
  `stg-seg--text` modifier for text segmented buttons.
- Modal body is ~720 px: the header's **Edit / Preview as agent** switch swaps the form for
  `AgentPreview` (rendered by `GET /api/profile/preview`, token count, sharing toggles) instead
  of a squeezed third column.
- Copy: "Applies to new agents. Running ones keep the prompt they started with." (canvas A updated).

**Memory view (B)** — `views/memory/`: `MemoryView.jsx` (takeover, like `ArchiveView`),
`SuggestionInbox.jsx`, `MemoryItem.jsx` (inline edit, tier toggle, delete), `MemoryComposer.jsx`,
`MemoryRail.jsx` (budget meter, `DreamingRow`; "read right now" lands with read telemetry, P6),
`lib/memoryGroups.js` (pure grouping/filter). `state/memoryViewStore.js` for the mode flag,
`hooks/useOpenMemory.js` to open it from anywhere; styles in `styles/memory.css`.

**Interview (C)** — `components/profile/ProfileInterview.jsx` full-window (reuse `.acc-welcome`
shell), steps as data in `lib/profileInterview.js` (`steps[]`, `toPatch(answers)`, validation) —
a new question = a new entry (OCP). Gate in `App.jsx`: welcome state machine becomes
`pending → welcome | interview | closed`; WelcomeScreen Continue → interview when
`profile.onboardedAt == null`; existing users see it once unless `onboarding.profileDismissed`.
Finish ⇒ one `saveProfile` with `onboardedAt`.

**Styles** — `styles/profile.css` (`prof-`, `mem-`, `intv-` prefixes), imported before `glass.css`;
menu rows join the existing `.acct-*` glass lists.

## SOLID map

- **S** — store (I/O) / service (rules + events) / renderer (text) / routes (HTTP) / tools (agent
  surface) / UI groups each own one reason to change.
- **O** — style phrases, interview steps, categories are tables; adding one touches no logic.
- **L** — `File*Store` and in-memory test fakes are interchangeable behind the ports.
- **I** — `UserMemoryReader` / `SuggestionSink` / `Editor`; tools and prompt assembly never see editor methods.
- **D** — core depends on ports + `Clock` + `bus.publish`; manager injects adapters.

## Phases (each ends green: `npm run lint`, package tests; never `eos build`/`restart`)

Status: **P0–P5 implemented** (2026-10-04). P6–P7 later.

| Phase | Scope | Verify |
|---|---|---|
| P0 | contracts schemas + ROUTES; core domain + `renderUserProfile` | contracts/core unit tests: defaults, patch, budget overflow, escaping, **empty ⇒ default text verbatim** |
| P1 | profile store/service/routes/avatar/CLAUDE.md import; `{{USER_PROFILE}}` injection with `knownLines`; preview script + route | infra store tests (tmpdir), route tests (403/409), prompt snapshot unchanged with no profile, changed with one, imported line not doubled |
| P2 | `ProfileAvatar`, footer + menu, Settings › Profile, new controls | vitest: store (409 path), `profileText`, SSR markup of groups/footer/menu, registry test |
| P3 | memory store/service/routes; always-on in renderer; `search_memory`/`suggest_memory` + role fragment; suggest notify | service tests (dedupe, cap, scope), route tests (subagent/withheld/ui-token), registration snapshot |
| P4 | Memory view (B), entry points, notification deep link (`route`) | vitest: `memoryGroups`, store, SSR markup |
| P5 | Interview (C) + gating | vitest: `profileInterview.toPatch`, gate decision fn |
| P6 (later) | read telemetry: `user_memory_reads` table (migration `061`), live "read right now" rail, reads/week | repo tests (`:memory:` + migrations) |
| P7 (later) | **Dreaming** — see below | use-case tests with fake summarizer, service gate tests |

## Future: Dreaming (not built now — seams built now)

What it is: while the user is away, a tool-less model call reviews finished chats and files
suggestions into the same inbox. Nothing is kept without approval.

Seams that exist after P0–P5, so Dreaming adds code without changing any of it:

| Seam | Built in | Dreaming adds |
|---|---|---|
| Producer-agnostic `UserMemorySuggestionSink.suggest(input, source)` (dedupe, cap, events, notify) | P3 | a second caller |
| `UserMemorySourceSchema` discriminated union | P0 | `{ kind: "dream", workerIds, at }` + its label in `MemoryItem` |
| Tool-less one-shot model call: `ConversationSummarizer` port (`SdkSummarizer`) | exists | prompt `manager/prompts/profile/dream.prompt.md` (JSON out, schema-validated; invalid ⇒ nothing) |
| Lane-neutral transcript read: `EventRepo.list({ afterId })` + `normalizeEventRows` | exists | watermark per worker (state.db table) so each turn is reviewed once |
| IDLE edge (`manager/daemon.ts` `drainFor`) / app-idle | exists | `DreamService.checkOnIdle` sibling: top-level only, not compacting, cooldown, min new turns |
| `DreamingRow` UI | P2 | reads `config.profile.dreaming.enabled` and becomes a live toggle |
| Config | — | `config.profile.dreaming { enabled: false, model, cooldownMs }` (four-edit config pattern) |

Core use-case shape (for when it is built): `dreamOverWorker(deps, { workerId })` →
read turns after watermark → summarizer → parse → `sink.suggest(each, { kind: "dream", … })`
→ advance watermark. Pure parse/filter lives in `core/src/domain/dream.ts`.

## Risks

- **Prompt injection via memories** — agent-suggested text may come from web/tool output.
  Mitigated by the user-approval gate, one-line data rendering, block-close escaping.
- **Privacy** — memories go to third-party providers: `withholdFrom` + per-project scope; project
  memories never render outside their project.
- **Token cost** — hard budget, on-demand tier, overflow hint instead of truncation.
- **Self-approval** — approval routes are ui-token only; agents hold no ui-token.
- **Instruction drift vs CLAUDE.md (D2)** — two sources can disagree. `knownLines` removes exact
  overlap; the preview shows exactly what each lane gets, so conflicts are visible, not hidden.
- **Remote hosts** — each daemon has its own profile; `/h/<host>/api/profile` shows the host's.
