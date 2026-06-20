# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

`Eos` is an orchestration layer **on top of the interactive `claude` CLI binary** (not the Agent SDK or `claude -p`). An "orchestrator" agent decomposes tasks and dispatches worker agents via MCP tools. A daemon supervises everything; a web UI (React 18 + Vite), CLI, and native macOS app (WKWebView in `app/`) provide live observation and control.

**Hard constraint:** every Claude session runs as an *interactive* PTY process so the user's Max/Pro subscription pays for tokens. **Never use `claude -p`** — it draws from a separate Agent SDK credit pool. Drive `claude` via `node-pty`; never write raw `text + "\r"` yourself — all message delivery goes through `spawner/delivery.ts` (verified bracketed paste → composer echo → CR → transcript ACK).

## Repository layout

```
contracts/        — Zod schemas + TS types (single source of truth for IPC shapes). Reusable primitives in src/shared.ts (UnknownRecordSchema, AllowVariant, DenyVariant).
core/             — Pure domain + ports + use-cases + services. Zero Node-specific imports.
infra/            — Adapter implementations for core/ ports (SQLite, child_process, chokidar, etc.).
infra/util/       — Cross-cutting infra utilities (safeStringify).
gateway/          — MCP permission server. Strategy: DaemonProxyPolicy (fail-closed) vs StandalonePolicy (defense-in-depth).
spawner/          — worker.ts composition root + submodules (options, delivery, tail, jsonl-parser, session, worktree, readiness-gate, ingest, claude-args, settings, events).
manager/          — daemon.ts (composition root + container + routes), cli.ts (Command pattern), orchestrator-mcp.ts, worker-mcp.ts, prompts/ (centralized prompt library — DPI role/env fragments + action templates + MCP tool descriptions), prompt-tool-names.ts + tool-descriptions.ts (prompt-system glue).
manager/services/ — Extracted stateful services (TurnSettleService, PendingQuestionService).
manager/routes/   — Split by concern: workers, orchestrators, policy, fs-picker, fs-read, fs-git, etc.
manager/shared/   — Centralized config (env→file→default, deeply frozen), daemon HTTP client, path utils.
scripts/hooks/    — auto-allow.sh (the PermissionRequest gateway hook).
app/              — Native macOS app. main.swift = WKWebView shell (loads the UI from the eos://app/ bundle origin via a custom scheme handler, not the daemon); build.sh → Eos.app.
app/ui/           — React 18 + Vite, the app's frontend (built dist/ is bundled into Eos.app). Tabbed multi-view shell: App picks the active view via views/registry.js; views/ (code/, workflows/), search/ ⌘K command-palette registry, state/ providers, api/client.js (typed HTTP + dedup), hooks/useLive.js (SSE+poll).
```

Each package has its own `package.json` + `node_modules`. **NOT a workspace** — install per directory. Cross-package imports use relative paths.

## Build and development

One-time setup (NOT a workspace — installs all 8 package dirs in dependency order):
```bash
npm run bootstrap                 # install every package dir (contracts→core→infra→gateway→spawner→manager→app/ui→root)
bash scripts/bootstrap.sh --link  # also symlink ~/.local/bin/eos
```

```bash
npm run lint                      # repo root — enforces dependency direction (per-glob allowlist)
cd manager && npm test            # tsx --test across manager/{shared,services}, core, spawner
cd contracts && npm test          # contracts/ + infra/ suites are NOT aggregated — run each separately
cd app/ui && npm test             # web suite (vitest); also separate from the above
cd app/ui && npm run build        # production build → dist/ (bundled into Eos.app by app/build.sh)
cd app/ui && npm run dev          # vite build --watch
bash app/build.sh                 # native macOS app → /Applications/Eos.app
```

Run a single test (node:test elsewhere, vitest filter on web):
```bash
cd manager && npx tsx --test --test-name-pattern="config" shared/__tests__/config.test.ts
cd app/ui && npx vitest run match
```

Deploy after code changes — one command, converges only what changed (content-hash stamps; exit 0 ⇒ everything running is current):
```bash
eos build             # deps → web dist → macOS app → daemon restart → app relaunch, each only if stale
eos build --dry-run   # show what would rebuild and why
eos build --check     # lint + all test suites before deploying
```
Stamps live inside the artifacts (`node_modules/.eos-stamp`, `dist/.eos-stamp`, app bundle Resources) and the daemon self-stamps `/health.sourceStamp` at boot — no side manifest; deleting an artifact just makes it dirty again. Input sets are defined once in `manager/builder/inputs.ts`; the backend set deliberately excludes `*.md` prompts, `scripts/hooks/`, and `manager/cli/` because those take effect without a restart.

UI delivery: the built UI (`app/ui/dist`) is **bundled into** `Eos.app/Contents/Resources/ui` by `app/build.sh`, and the WKWebView loads it from the `eos://app/` custom-scheme origin (`BundledUISchemeHandler` in `main.swift`) — the daemon no longer serves it over HTTP (there is no `/web/` route). A UI change therefore makes the **app bundle** stale (`appSpec` in `manager/builder/inputs.ts` folds in the web inputs), so `eos build` rebuilds + relaunches the app rather than reloading a page in place. The quit+reopen is verified: quit waits for LaunchServices deregistration (`lsappinfo`, not just pgrep — LS lags process exit ~40ms and `open` in that window fails with -600), then `open` is retried up to 3× and must yield a pid that survives 1.5s. `app/build.sh` refreshes the LS registration (`lsregister -f`) after each install. Because the WebView runs on `eos://app/` while the API stays on `http://127.0.0.1:7400`, the API server sets reflect-origin CORS (loopback-only, mutations still gated by `x-eos-ui-token`) in `daemon.ts`'s `makeHandler` — never on the raw server. The `ui:reload` SSE event still exists but is no longer the UI-delivery path.

Manual daemon restart (kill orphans, keep DB):
```bash
eos restart           # restart only
eos restart --db      # also wipe state.db*
```

CLI: `eos help` for all commands. Symlink `~/.local/bin/eos` → `manager/bin/eos` (bash launcher that execs `node --experimental-strip-types manager/cli.ts`).

HTTP surface: all endpoints defined in `contracts/src/http.ts` ROUTES table.

## Gotchas (read before editing)

### Node vs Bun

- **worker.ts = Node only** — Bun + node-pty is broken (`pty.onData` never fires under Bun's N-API).
- **gateway = Bun** — faster stdio startup. `mcp.json` uses absolute bun path because Claude's PATH inheritance is unreliable.

### Permission flow: hook-as-gateway

Claude prefers its interactive prompt over `--permission-prompt-tool` MCP when a `PermissionRequest` hook exists — so the gateway *is* the hook. `scripts/hooks/auto-allow.sh` (wired per-worker in `spawner/settings.ts`) checks `EOS_SPAWNED`, then **branches on tool name**:

- `AskUserQuestion` → **hard deny** (no daemon round-trip). The tool is disabled platform-wide; the deny message redirects to `mcp__orchestrator__ask_user` / `needs input:`. Same deny is enforced in `worker.ts` PreToolUse (the only gate under native bypassPermissions, where PermissionRequest never fires) and `PolicyGatewayService` step 0 — single source: `BLOCKED_BUILTIN_TOOLS` in `contracts/src/tool-scope.ts`.
- every other tool → `POST /policy/decide`, returns the decision verbatim.

The hook only accepts `"allow"`/`"deny"` behavior values; anything else falls through to standalone default. Output shape (empirically verified — `updatedInput` is a **sibling** of `decision`, NOT nested inside it):

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "allow|deny", "message"?: "..." },
    "updatedInput"?: { ... }
  }
}
```

`settings.ts` also wires PreToolUse/PostToolUse HTTP hooks that emit `tool_running`/`tool_done` events (live tool indicators, no state change). Web UI renders a **PermissionBanner** (Deny / Always allow / Allow once ⌘↵; "Always allow" appends a rule to `policy.yaml` via `POST /api/policy/rule`) and a **QuestionBanner** for the orchestrator's `ask_user` questions.

### Per-worker permission mode

`PolicyGatewayService.decide()` is a 3-step chain: (1) explicit `policy.yaml` rule wins; (2) else the worker's permission mode — `classifyTool()` buckets the tool into read/mcp/fileEdit/planFile/shell/network/other, then `MODE_SPECS[mode]` decides. `read`, `mcp__*` and `planFile` (a fileEdit targeting `~/.claude/plans/` — traversal-normalized, so plan mode can still write its plan artifact) are **always allowed**; `acceptEdits` also allows fileEdit; `plan` denies fileEdit/shell/network; `bypassPermissions` allows all; `default` asks for anything not read/mcp/planFile. (3) else `policy.default`. Adding a mode is data-only: one entry in `MODE_SPECS` (`core/src/domain/permission-mode.ts`).

Effective mode = `SqlBackedModeResolver.resolveFor(id)`, which climbs `parent_id` until an ancestor has an explicit mode (children inherit the orchestrator's). `PUT /workers/:id/permission {mode, cascade?}` persists it and (cascade default ON) BFS-updates the whole subtree; children pick it up at their next tool-call, not via a live slash command.

### Worker env vars (required for daemon-aware mode)

```
EOS_SPAWNED=1              — tells hook to delegate to daemon
EOS_WORKER_ID=<id>        — routes events to correct worker
EOS_DAEMON_URL=http://127.0.0.1:7400
```

Missing any → hook falls through to default auto-allow, gateway loop breaks.

### Worker boot race: readiness-gate

Pre-boot PTY writes get eaten by the un-mounted TUI → silently lost prompt. `worker.ts` buffers all writes until `readiness-gate.ts` sees the composer border glyph `╭` (the only ready-marker stable across every permission mode) plus a quiescence window (`readinessSettleMs` 250; fallback `readinessFallbackMs` 2500), THEN flushes and writes `opts.prompt`. **Never write the prompt before `onBootReady` fires.** (The old prompt-ack watchdog / `prompt_unacknowledged` → IDLE(`prompt_lost`) system was removed — too many false positives on slow boots.)

### Post-turn settle window

hook and jsonl ride independent fire-and-forget channels, so trailing transcript JSONL of a finished turn can arrive **after** the Stop hook and falsely re-animate a just-idled worker. `TurnSettleService`: the Stop-hook handler `markSettling` before transitioning to IDLE; while settling (4000ms) heartbeat/jsonl/PostToolUse WORKING-transitions are suppressed and IDLE won't heal (trailing tool_use is still counted). A genuine new turn (user/orchestrator message, interrupt, worker report) MUST call `c.turnSettle.clear(id)` first or the window starves it — see `clear()` in `manager/routes/{workers,orchestrators}.ts`.

### ask_user pipeline (AskUserQuestion is disabled)

The builtin `AskUserQuestion` is hard-denied everywhere (see Permission flow above) — its old keystroke answer machinery (answer-driver, `/answer` ingest, `selections`) is deleted; don't reintroduce it. The human-question channel is the orchestrator-only MCP tool `mcp__orchestrator__ask_user` (`manager/orchestrator-mcp/tools/ask_user.ts`), register-then-poll over plain HTTP: `POST /workers/:id/question` registers in `PendingQuestionService` (state-based, in-memory, **no TTL** — a question may wait days; `MCP_TOOL_TIMEOUT` is lifted in the worker PTY env for this) and returns `{questionId}`; the tool polls `GET /workers/:id/question/:questionId` every 2.5s until `answered`/`dismissed`/`gone` (gone = daemon restart, supersede, or worker kill — never an error HTTP code). `question_pending` also fires a `notification:fire` ("Input needed") because the blocked orchestrator can't notify_user itself. The web QuestionBanner answers via `POST /workers/:id/question-answer {toolUseId, answers}` or `{toolUseId, dismissed:true}`; `question_answered` dismisses the banner durably and the poller returns the answers as the tool result.

### PTY write: verified delivery pipeline (delivery.ts)

`DeliveryPipeline` serializes all message writes through one promise chain (concurrent `/message` POSTs otherwise interleave bytes — a PTY has no message boundaries) and verifies each delivery instead of trusting timers: (1) text goes out wrapped in explicit bracketed-paste markers `\x1b[200~…\x1b[201~` in ONE write; (2) the CR is sent as soon as the composer **echoes** the text back (normalized match: ANSI + whitespace + box-drawing stripped; large pastes match the `[Pasted text` placeholder) — the fixed 300ms delay (`--pty-write-delay-ms`) is now only the fallback when no echo shows; (3) the message appearing as a **user entry in the transcript JSONL** (`user_text`, never forwarded raw) is the end-to-end ACK. Retry ladder is duplicate-proof: echo OK + no ACK → one re-CR then `delivery_unverified`; no echo + no ACK → Esc + re-paste up to 3 attempts then `delivery_failed` (daemon heals the eager WORKING back to IDLE; chat shows a red line). Turn-ACK is **skipped mid-turn** — a steering message is queued by the TUI and hits the transcript minutes later, so an ACK timeout there would re-paste and duplicate it. Keystrokes (`/keystroke`, AUQ answers) still bypass the pipeline.

**Transcript-anchored message events**: the daemon does NOT append `user_message`/`orchestrator_message` at dispatch — a dispatch-time append races the previous turn's trailing jsonl and gets durably ordered above the agent's final output. Instead the `/message` body carries a `record` meta (contracts `MessageRecordSchema`); the worker registers it (`spawner/message-registry.ts`) and emits the chat event when the matching `user_text` shows up in the transcript (same FIFO event queue as the surrounding jsonl ⇒ true conversation order; mid-turn steers land where Claude actually consumed them). Resolution: ACK/consumed → emitted at the sighting; `delivery_unverified` → emitted at resolution; `delivery_failed` → never emitted (the web drops the optimistic copy on the failure event); interrupt/exit → pending entries flushed. `worker_report` rides the same mechanism (the PARENT's registry; displayText = the unwrapped report body). Control traffic (`/model`, `/permissions` slash sends) sends NO record and must never produce a chat event. Boot prompts are still daemon-appended at spawn (no prior output to race). Backends without `reportsMessageEvents` (in-process) keep the dispatch-time append.

### Daemon-side message queue + clientMsgId idempotency

Dashboard sends carry `clientMsgId` (uuid) + `queueWhenBusy: true`. Idempotency: `queued_messages` has UNIQUE(worker_id, client_msg_id) — a duplicate POST is a silent `{deduped:true}` no-op, so one message can never become two turns (dispatched rows stay ~24h as the dedup ledger; pruned at daemon startup). Queue: a message hitting a **WORKING** worker (or an IDLE one with a pending backlog — a direct dispatch must never overtake the queue) is held server-side (202 `{queued:true}`) and drained **FIFO, one message per IDLE transition** — each dispatched turn's own Stop→IDLE triggers the next row (`DrainQueuedMessages`, wired in daemon.ts to bus `worker:change`; fires on `state:"IDLE"` or the enqueue's `queued:true` payload). `/clear` also clears pending rows (a fresh context must not receive the old conversation's queue). The web NEVER dispatches from render effects (the old `Messages.jsx` auto-flush is deleted — don't reintroduce it); pills mirror `GET /workers/:id/queue`, dismiss = `DELETE /workers/:id/queue/:queueId`. `/interrupt` clears pending rows BEFORE its IDLE transition (Esc cancels queued messages). SPAWNING does NOT queue — the worker-side readiness gate buffers pre-boot writes, and queue-on-SPAWNING would deadlock resumed sessions (they only reach IDLE through a turn). Agent-plane traffic queues when the target is busy: `worker_report` AND the orchestrator directive (`message_worker` → `/message` fromParent) both send `queueWhenBusy: true` and drain at the target's next IDLE as agent-plane rows — a direct mid-turn PTY steer skips ACK/retry (delivery.ts `isTurnActive`) and is silently lost with no post-turn redelivery. Only `/action` (dashboard predefined actions) still dispatches directly without `queueWhenBusy`. `user_message` events echo `clientMsgIds` back; the web reconciles optimistic bubbles by id (`lib/optimisticReconcile.js` — text-prefix fallback, 10min TTL, purge on agent delete). Unkeyed same-text re-dispatch within 10s appends a log-only `duplicate_dispatch_suspected` lifecycle event.

### macOS `/tmp` symlink

`/tmp` → `/private/tmp`. Claude writes JSONL under `~/.claude/projects/<encoded-realpath-cwd>/`. Worker.ts must `realpathSync(cwd)` before computing the encoded directory or chokidar watches a non-existent path. Encoding: replace every char not in `[a-zA-Z0-9_-]` with `-`.

### Events query ordering

`/workers/:id/events?limit=N&order=desc` returns newest N in **ASC** order (double-sort: inner DESC LIMIT N, outer ASC). Do NOT regress to `ORDER BY ts ASC LIMIT N` — that gives the oldest N.

### Worker exit codes

- `129` = SIGHUP from normal shutdown after Stop hook → **success**, not error
- `143` = SIGTERM from kill action
- Anything else = real crash → red in UI

### Policy long-poll timeouts

`/policy/decide` blocks until a human decides. There is **no** `ttlMs` auto-deny timer (removed). `policy.ttlMs` now only seeds the pending row's `expiresAt`, which `sweepExpired()` consults lazily on worker exit to mark stranded `ask` pendings expired — it never denies a live worker mid-wait. The only hard ceiling is the abort timeout (3600s), shared by the hook curl and the gateway (`EOS_POLICY_TIMEOUT_MS`) — keep them coordinated if changed.

### Temp dir prefix

Workers use `eos-<name>-XXXXXX` via `mkdtempSync`. Don't rename — daemon's `pgrep -f "eos-<name>-"` depends on it for orphan cleanup.

### SQLite migrations

`infra/src/persistence/MigrationRunner.ts` runs an ordered `MIGRATIONS: {id, sql}[]` array on startup; applied ids are recorded in `schema_migrations` so each runs once. New column: append `{id:"NNN_...", sql:"ALTER TABLE … ADD COLUMN …"}` — `runMigrations()` already wraps it in try/catch (duplicate-column = treated as applied); don't hand-roll your own. On every startup, before opening the DB, the daemon snapshots the user-data manifest (`manager/shared/user-data.ts` → `StartupBackupService`) into `~/.eos/backups/<stamp>/` (newest 5).

### Daemon home (`~/.eos`) is user data — never rm/mv it by hand

Non-regenerable user data in the home is declared ONCE in `manager/shared/user-data.ts` (state.db, templates/, policy.yaml, config.json); `StartupBackupService` and any future home migration consume that manifest — a new user-data file added to the home MUST be added there too, or it lives outside every safety net. Never `rm -rf`/`mv` the daemon home in scripts or agent sessions (the 2026-06-08 `.claude-mgr`→`.eos` hand migration `rm -rf`'d a home the daemon had been writing to for hours); a future home move = daemon-owned merge step, never destroy. Template deletes are soft (`templates/.trash/`). Agent smoke tests must NOT CRUD the production store — boot a throwaway daemon with `EOS_HOME=$(mktemp -d)`.

### Cost is display-only

Per-worker cost/elapsed budget enforcement was removed (`LimitsEnforcer`, the `limit_exceeded` event, and `maxCostUsd`/`maxElapsedMs` on spawn are all gone). Cost is tracked and shown, never enforced — don't reintroduce caps without re-adding the limit bus topic. The price table has a 1h ephemeral-cache tier (`cacheCreate1h`); a partial `prices` override in `config.json` merges per-field (a flat replace yields NaN).

### Orchestrator = worker with flags

Same worker.ts code. Distinguished by `--persistent` (no auto-shutdown), `--mcp-config` (orchestrator MCP tools), and its assembled system prompt. The real claude flag is `--append-system-prompt-file` (`claude-args.ts`); worker.ts's internal `--system-prompt-file` arg maps to it. Orchestrators default to `default` permission mode (NOT bypassPermissions — must opt in). The appended system prompt is **assembled per-spawn by DPI keyed on the role** (see Prompt system + DPI below) — there are no static `*-prompt.md` files anymore. Workers report back via `worker-mcp/tools/send_message_to_parent.ts`.

### Prompt system + DPI (system prompts are assembled, not static)

Full design: `docs/design/prompt-system-and-dpi.md`. Two daemon-side layers over the centralized library at `manager/prompts/` (`*.prompt.md` = YAML frontmatter + body).

- **Layer 1 — Prompt System**: `PromptService.render(id, locals?, vars?)` (SYNCHRONOUS) over a tiny `{{VAR}}` / `{{#if}}` / `{{#unless}}` engine. Precedence local > session vars > static globals; missing var → empty. `parseTemplate` is STRICT — a malformed token / unbalanced block THROWS (registry catches + skips). Variables are a flat UPPER_SNAKE name list in frontmatter. **Never hardcode a tool name in a prompt** — use `{{*_TOOL}}`, sourced from each tool module's `.name` via `manager/prompt-tool-names.ts`.
- **Layer 2 — DPI**: at the single spawn chokepoint `ClaudeCliBackend.start()`, `assembleSystemPrompt` (core use-case) derives session **facts** from the spawn context, selects fragments whose declarative `when` matches, orders by layer-rank→priority, renders each, composes the appended prompt; the container's `assembleSystemPromptFile` writes it per-worker (`~/.eos/system-prompt-<id>.md`, cleaned alongside the mcp config). Covers worker + orchestrator + resume.
- **Conditioning rule (critical)**: the prompt is fixed at launch, so a `when` may gate ONLY on session-IMMUTABLE facts — `role`, `isSubagent`, `isWorktree`, `isAttached`. NEVER gate on mutable facts (git can be added mid-session; model/effort/permission change at runtime) — those stay always-on. There are no FactProvider/VariableProvider seams (trimmed); facts come straight from the spawn ctx via `deriveFacts`.
- **Layout**: role prompts are split by concern under `prompts/role/<role>/NN-*.prompt.md`; the worktree env block is `prompts/env/worktree{,-shared}.prompt.md` (gated on `isWorktree`/`isAttached`, layer `custom` so it follows the role body); MCP tool descriptions are `prompts/tool/<name>.prompt.md` (rendered + injected at MCP startup via `manager/tool-descriptions.ts`'s `withToolDescriptions` Proxy — never inline in the tool module); action templates (`commit`, `create-pr`, …) are plain Layer-1 prompts. Prompt-content edits apply on the next spawn (read fresh, no restart); `~/.eos/prompts/` overrides built-ins. `eos prompts validate` checks the whole library (frontmatter, templates, vars, DPI conditions).

## Style notes

- No comments unless *why* is non-obvious. Keep existing comments on: `delivery.ts` retry-ladder rationale, `worktree.ts` realpath dance, `auto-allow.sh`.
- Use `safeStringify()` from `infra/src/util/json.ts` instead of raw `JSON.stringify()` for values that could be non-serializable.
- Use `e instanceof Error ? e.message : String(e)` in catch blocks — never `(e as Error).message`.
- All code/CLI output in English. User web messages may be Turkish.

## Clean Architecture rules

Dependency direction: `contracts/` → `core/` → `infra/` → entrypoints. **Enforced at lint time** via `no-restricted-imports` in `eslint.config.js`. No Node-specific imports in `core/`. Core uses `Clock` port everywhere — never `Date.now()` directly. The lint rules are a hand-maintained **per-glob allowlist**: `manager/worker-mcp/` and any new top-level dir under `core/src/` outside `{domain,ports,use-cases,services,errors}` silently escape the bans — add new paths to the glob list when you introduce them.

Adding new things:
- **HTTP endpoint**: schema in `contracts/src/http.ts` (+ ROUTES entry) → route in `manager/routes/` → register in `manager/daemon.ts`
- **Event type**: add to enum in `contracts/src/events.ts`. HANDLERS in `core/src/use-cases/ProcessWorkerEvent.ts` is **partial** — add a handler only if a worker-pushed event must drive state (log-only events need none). Daemon-synthesized events (e.g. question_pending, worker_report, orchestrator_message, state_reject) are appended directly via `c.events.append(...)` in their route — there is no central dispatcher for those.
- **CLI command**: `manager/cli/commands/<name>.ts` implementing `Command` → register in `registry.ts`
- **MCP tool**: `manager/orchestrator-mcp/tools/` or `manager/worker-mcp/tools/` implementing `McpToolModule` → add to `tool-registry.ts`. Its description is NOT inline — author `manager/prompts/tool/<name>.prompt.md` (injected at MCP startup); add a `{{*_TOOL}}` var to `prompt-tool-names.ts` if other prompts reference the tool by name.
- **Prompt / DPI fragment**: drop a `*.prompt.md` under `manager/prompts/` (role/env/tool/action); add a `dpi:` block (`layer`, `priority`, `when`) to make it a DPI fragment; declare interpolated `{{VARS}}` (UPPER_SNAKE) in frontmatter; gate `when` only on immutable facts; `eos prompts validate`. See "Prompt system + DPI" above.
- **Web view (tab)**: 4 touch-points — workspace Component `views/<name>/<Name>View.jsx` wrapping `<AppLayout>`; descriptor `views/<name>/meta.jsx` (`{id, label, Icon}`); register the descriptor in `views/tabs.js` TABS; map id→Component in `views/registry.js`. tabs.js (descriptors) and registry.js (Components) are split to avoid an import cycle (TabBar renders inside every view). Add a ⌘K palette result source as a plain `{id, label, getResults}` provider in `search/index.js` — the palette itself never changes.
- **Infra concern**: port in `core/src/ports/` → impl in `infra/src/<concern>/` → wire in `manager/container.ts`
- **Shared schema**: reusable Zod primitives go in `contracts/src/shared.ts` (e.g. `UnknownRecordSchema`)
- **Manager service**: stateful extracted logic goes in `manager/services/` (e.g. `TurnSettleService`, `PendingQuestionService`)
- **Policy rule**: `POST /api/policy/rule` appends to `~/.eos/policy.yaml` + reloads; used by web UI "Always allow"

Config is deeply frozen after load. To mutate at runtime: write the updated `~/.eos/config.json` yourself, THEN call `container.reloadConfig()` (it only drops the cache and re-reads disk — it does NOT write the file). No endpoint mutates config at runtime; every config change needs a daemon restart. Never `Object.assign` on live config.

Node.js strip-only TS mode: don't use parameter properties (`constructor(private x: T)`) — use explicit field + assignment.
