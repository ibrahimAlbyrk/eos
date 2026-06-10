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
manager/          — daemon.ts (composition root + container + routes), cli.ts (Command pattern), orchestrator-mcp.ts, worker-mcp.ts, {orchestrator,worker}-prompt.md (externalized system prompts).
manager/services/ — Extracted stateful services (TurnSettleService, PendingQuestionService).
manager/routes/   — Split by concern: workers, orchestrators, policy, fs-picker, fs-read, fs-git, etc.
manager/shared/   — Centralized config (env→file→default, deeply frozen), daemon HTTP client, path utils.
manager/web/      — React 18 + Vite. Tabbed multi-view shell: App picks the active view via views/registry.js; views/ (code/, workflows/), search/ ⌘K command-palette registry, state/ providers, api/client.js (typed HTTP + dedup), hooks/useLive.js (SSE+poll).
scripts/hooks/    — auto-allow.sh (the PermissionRequest gateway hook). ask-question.sh exists but is NOT wired (dead).
app/              — Native macOS WKWebView wrapper. build.sh → Eos.app.
```

Each package has its own `package.json` + `node_modules`. **NOT a workspace** — install per directory. Cross-package imports use relative paths.

## Build and development

One-time setup (NOT a workspace — installs all 8 package dirs in dependency order):
```bash
npm run bootstrap                 # install every package dir (contracts→core→infra→gateway→spawner→manager→manager/web→root)
bash scripts/bootstrap.sh --link  # also symlink ~/.local/bin/eos
```

```bash
npm run lint                      # repo root — enforces dependency direction (per-glob allowlist)
cd manager && npm test            # tsx --test across manager/{shared,services}, core, spawner
cd contracts && npm test          # contracts/ + infra/ suites are NOT aggregated — run each separately
cd manager/web && npm test        # web suite (vitest); also separate from the above
cd manager/web && npm run build   # production build → dist/
cd manager/web && npm run dev     # vite build --watch
bash app/build.sh                 # native macOS app → /Applications/Eos.app
```

Run a single test (node:test elsewhere, vitest filter on web):
```bash
cd manager && npx tsx --test --test-name-pattern="config" shared/__tests__/config.test.ts
cd manager/web && npx vitest run match
```

Daemon restart after code changes (kill orphans, keep DB):
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

- `AskUserQuestion` → **fire-and-forget** `POST /workers/:id/question-notify` (surfaces the web QuestionBanner), then returns `{}` so Claude renders its native TUI menu. The hook does NOT block, and `updatedInput` does NOT pre-fill answers (empirically Claude ignores it and reports "user did not answer"). Answers come back as keystrokes (single-select: the option number) or, for multi-select/free-text, an interrupt + plain message.
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

`settings.ts` also wires PreToolUse/PostToolUse HTTP hooks that emit `tool_running`/`tool_done` events (live tool indicators, no state change). Web UI renders a **PermissionBanner** (Deny / Always allow / Allow once ⌘↵; "Always allow" appends a rule to `policy.yaml` via `POST /api/policy/rule`) and a **QuestionBanner** for AskUserQuestion.

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

### AskUserQuestion pipeline

**Fire-and-forget**, distinct from the permission flow. `auto-allow.sh` POSTs `/workers/:id/question-notify` (daemon appends `question_pending` + publishes `worker:change`, then returns immediately) and lets Claude's native TUI menu render. The web UI shows a **QuestionBanner**; answers go back as raw keystrokes via `POST /workers/:id/keystroke` (single-select: option number, no CR) or, for multi-select/free-text, `POST /workers/:id/interrupt` then a normal `/message`. `POST /workers/:id/question-answer` records `question_answered` to dismiss the banner durably. NOTE: a BLOCKING variant still exists in code (`POST /workers/:id/question` → `PendingQuestionService` long-poll, plus `worker.ts onQuestionHook`) but is **currently dead/unwired** — `ingest.ts` routes no path to it. It is the natural in-process human-prompt channel to resurrect for non-PTY backends (see `docs/adr/0001-backend-agnostic-agent-platform.md`). `scripts/hooks/ask-question.sh` is also dead — the live logic is in `auto-allow.sh`.

### PTY write: verified delivery pipeline (delivery.ts)

`DeliveryPipeline` serializes all message writes through one promise chain (concurrent `/message` POSTs otherwise interleave bytes — a PTY has no message boundaries) and verifies each delivery instead of trusting timers: (1) text goes out wrapped in explicit bracketed-paste markers `\x1b[200~…\x1b[201~` in ONE write; (2) the CR is sent as soon as the composer **echoes** the text back (normalized match: ANSI + whitespace + box-drawing stripped; large pastes match the `[Pasted text` placeholder) — the fixed 300ms delay (`--pty-write-delay-ms`) is now only the fallback when no echo shows; (3) the message appearing as a **user entry in the transcript JSONL** (`user_text`, never forwarded raw) is the end-to-end ACK. Retry ladder is duplicate-proof: echo OK + no ACK → one re-CR then `delivery_unverified`; no echo + no ACK → Esc + re-paste up to 3 attempts then `delivery_failed` (daemon heals the eager WORKING back to IDLE; chat shows a red line). Turn-ACK is **skipped mid-turn** — a steering message is queued by the TUI and hits the transcript minutes later, so an ACK timeout there would re-paste and duplicate it. Keystrokes (`/keystroke`, AUQ answers) still bypass the pipeline.

**Transcript-anchored message events**: the daemon does NOT append `user_message`/`orchestrator_message` at dispatch — a dispatch-time append races the previous turn's trailing jsonl and gets durably ordered above the agent's final output. Instead the `/message` body carries a `record` meta (contracts `MessageRecordSchema`); the worker registers it (`spawner/message-registry.ts`) and emits the chat event when the matching `user_text` shows up in the transcript (same FIFO event queue as the surrounding jsonl ⇒ true conversation order; mid-turn steers land where Claude actually consumed them). Resolution: ACK/consumed → emitted at the sighting; `delivery_unverified` → emitted at resolution; `delivery_failed` → never emitted (the web drops the optimistic copy on the failure event); interrupt/exit → pending entries flushed. `worker_report` rides the same mechanism (the PARENT's registry; displayText = the unwrapped report body). Control traffic (`/model`, `/permissions` slash sends) sends NO record and must never produce a chat event. Boot prompts are still daemon-appended at spawn (no prior output to race). Backends without `reportsMessageEvents` (in-process) keep the dispatch-time append.

### macOS `/tmp` symlink

`/tmp` → `/private/tmp`. Claude writes JSONL under `~/.claude/projects/<encoded-realpath-cwd>/`. Worker.ts must `realpathSync(cwd)` before computing the encoded directory or chokidar watches a non-existent path. Encoding: replace every char not in `[a-zA-Z0-9_-]` with `-`.

### Events query ordering

`/workers/:id/events?limit=N&order=desc` returns newest N in **ASC** order (double-sort: inner DESC LIMIT N, outer ASC). Do NOT regress to `ORDER BY ts ASC LIMIT N` — that gives the oldest N.

### Worker exit codes

- `129` = SIGHUP from normal shutdown after Stop hook → **success**, not error
- `143` = SIGTERM from kill action
- Anything else = real crash → red in UI

### Policy long-poll timeouts

`/policy/decide` blocks until a human decides. There is **no** `ttlMs` auto-deny timer (removed). `policy.ttlMs` now only seeds the pending row's `expiresAt`, which `sweepExpired()` consults lazily on worker exit to mark stranded `ask` pendings expired — it never denies a live worker mid-wait. The only hard ceiling is the abort timeout (3600s), shared by the hook curl and the gateway (`EOS_POLICY_TIMEOUT_MS`) — keep them coordinated if changed. (The worker-side question long-poll that also used this ceiling is currently dead code; see the AskUserQuestion pipeline note.)

### Temp dir prefix

Workers use `eos-<name>-XXXXXX` via `mkdtempSync`. Don't rename — daemon's `pgrep -f "eos-<name>-"` depends on it for orphan cleanup.

### SQLite migrations

`infra/src/persistence/MigrationRunner.ts` runs an ordered `MIGRATIONS: {id, sql}[]` array on startup; applied ids are recorded in `schema_migrations` so each runs once. New column: append `{id:"NNN_...", sql:"ALTER TABLE … ADD COLUMN …"}` — `runMigrations()` already wraps it in try/catch (duplicate-column = treated as applied); don't hand-roll your own. The daemon backs up `state.db` (newest 5 in `~/.eos/backups/`) on every startup before opening it.

### Cost is display-only

Per-worker cost/elapsed budget enforcement was removed (`LimitsEnforcer`, the `limit_exceeded` event, and `maxCostUsd`/`maxElapsedMs` on spawn are all gone). Cost is tracked and shown, never enforced — don't reintroduce caps without re-adding the limit bus topic. The price table has a 1h ephemeral-cache tier (`cacheCreate1h`); a partial `prices` override in `config.json` merges per-field (a flat replace yields NaN).

### Orchestrator = worker with flags

Same worker.ts code. Distinguished by `--persistent` (no auto-shutdown), `--mcp-config` (orchestrator MCP tools), and an orchestrator system-prompt file. The real claude flag is `--append-system-prompt-file` (`claude-args.ts`); worker.ts's internal `--system-prompt-file` arg maps to it. Orchestrators default to `default` permission mode (NOT bypassPermissions — must opt in). System prompts are externalized markdown (`manager/{orchestrator,worker}-prompt.md`); the **worker** prompt is applied only when `parentId` is set, so editing `worker-prompt.md` affects only orchestrator-dispatched workers. Workers report back via `worker-mcp/tools/send_message_to_parent.ts`.

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
- **MCP tool**: `manager/orchestrator-mcp/tools/` or `manager/worker-mcp/tools/` implementing `McpToolModule` → add to `tool-registry.ts`
- **Web view (tab)**: 4 touch-points — workspace Component `views/<name>/<Name>View.jsx` wrapping `<AppLayout>`; descriptor `views/<name>/meta.jsx` (`{id, label, Icon}`); register the descriptor in `views/tabs.js` TABS; map id→Component in `views/registry.js`. tabs.js (descriptors) and registry.js (Components) are split to avoid an import cycle (TabBar renders inside every view). Add a ⌘K palette result source as a plain `{id, label, getResults}` provider in `search/index.js` — the palette itself never changes.
- **Infra concern**: port in `core/src/ports/` → impl in `infra/src/<concern>/` → wire in `manager/container.ts`
- **Shared schema**: reusable Zod primitives go in `contracts/src/shared.ts` (e.g. `UnknownRecordSchema`)
- **Manager service**: stateful extracted logic goes in `manager/services/` (e.g. `TurnSettleService`, `PendingQuestionService`)
- **Policy rule**: `POST /api/policy/rule` appends to `~/.eos/policy.yaml` + reloads; used by web UI "Always allow"

Config is deeply frozen after load. To mutate at runtime: write the updated `~/.eos/config.json` yourself, THEN call `container.reloadConfig()` (it only drops the cache and re-reads disk — it does NOT write the file). No endpoint mutates config at runtime; every config change needs a daemon restart. Never `Object.assign` on live config.

Node.js strip-only TS mode: don't use parameter properties (`constructor(private x: T)`) — use explicit field + assignment.
