# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

`Eos` is an orchestration layer **on top of the interactive `claude` CLI binary** (not the Agent SDK or `claude -p`). An "orchestrator" agent decomposes tasks and dispatches worker agents via MCP tools. A daemon supervises everything; a web UI (React 18 + Vite), CLI, and native macOS app (WKWebView in `app/`) provide live observation and control.

**Hard constraint:** every Claude session runs as an *interactive* PTY process so the user's Max/Pro subscription pays for tokens. **Never use `claude -p`** — it draws from a separate Agent SDK credit pool. Drive `claude` via `node-pty`, write prompts by `pty.write(text + "\r")`.

## Repository layout

```
contracts/        — Zod schemas + TS types. Single source of truth for all IPC shapes.
contracts/shared  — Reusable schema primitives (UnknownRecordSchema, AllowVariant, DenyVariant).
core/             — Pure domain + ports (interfaces) + use-cases. Zero Node-specific imports.
infra/            — Adapter implementations for core/ ports (SQLite, child_process, chokidar, etc.).
infra/util/       — Cross-cutting infra utilities (safeStringify).
gateway/          — MCP permission server. Strategy: DaemonProxyPolicy vs StandalonePolicy.
spawner/          — worker.ts composition root + submodules (pty-queue, tail, jsonl-parser, session, worktree, etc.).
manager/          — daemon.ts (composition root + container + routes), cli.ts (Command pattern), orchestrator-mcp.ts, worker-mcp.ts.
manager/services/ — Extracted stateful services (InterruptCooldownService).
manager/routes/   — Split by concern: workers, orchestrators, policy, fs-picker, fs-read, fs-git, etc.
manager/shared/   — Centralized config (env→file→default, deeply frozen), daemon HTTP client, path utils.
manager/web/      — React 18 + Vite. api/client.js (typed HTTP + request dedup), hooks/useLive.js (SSE+poll), state/.
app/              — Native macOS WKWebView wrapper. build.sh → Eos.app.
```

Each package has its own `package.json` + `node_modules`. **NOT a workspace** — install per directory. Cross-package imports use relative paths.

## Build and development

```bash
npm run lint                      # repo root — enforces dependency direction
cd manager && npm test            # tests across manager/shared, core, spawner
cd manager/web && npm run build   # production build → dist/
cd manager/web && npm run dev     # vite build --watch
bash app/build.sh                 # native macOS app → /Applications/Eos.app
```

Daemon restart after code changes (clean DB + kill orphans):
```bash
eos restart
```

CLI: `eos help` for all commands. Symlink: `~/.local/bin/eos`.

HTTP surface: all endpoints defined in `contracts/src/http.ts` ROUTES table.

## Gotchas (read before editing)

### Node vs Bun

- **worker.ts = Node only** — Bun + node-pty is broken (`pty.onData` never fires under Bun's N-API).
- **gateway = Bun** — faster stdio startup. `mcp.json` uses absolute bun path because Claude's PATH inheritance is unreliable.

### Permission flow: hook-as-gateway

Claude prefers interactive prompt over `--permission-prompt-tool` MCP when a `PermissionRequest` hook exists. The hook is configured **per-worker** in `spawner/settings.ts` (added to the generated settings.json alongside other hooks). `scripts/hooks/auto-allow.sh` checks `CLAUDE_MGR_SPAWNED` env var → forwards to `POST /policy/decide` → returns decision verbatim. The hook only accepts `"allow"` or `"deny"` behavior values; anything else falls through to standalone default. Output shape (empirically verified — `updatedInput` is a **sibling** of `decision`, NOT nested inside it):

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "allow|deny", "message"?: "..." },
    "updatedInput"?: { ... }
  }
}
```

Web UI renders a **PermissionBanner** above the composer with Deny / Always allow / Allow once (⌘↵) buttons. "Always allow" adds a permanent rule to `policy.yaml` via `POST /api/policy/rule`.

### Worker env vars (required for daemon-aware mode)

```
CLAUDE_MGR_SPAWNED=1              — tells hook to delegate to daemon
CLAUDE_MGR_WORKER_ID=<id>        — routes events to correct worker
CLAUDE_MGR_DAEMON_URL=http://127.0.0.1:7400
```

Missing any → hook falls through to default auto-allow, gateway loop breaks.

### PTY write: 300ms CR delay

`pty-queue.ts` splits text and carriage return into two writes with 300ms gap. Required because bracketed-paste mode swallows CR in the same write.

### macOS `/tmp` symlink

`/tmp` → `/private/tmp`. Claude writes JSONL under `~/.claude/projects/<encoded-realpath-cwd>/`. Worker.ts must `realpathSync(cwd)` before computing the encoded directory or chokidar watches a non-existent path. Encoding: replace every char not in `[a-zA-Z0-9_-]` with `-`.

### Events query ordering

`/workers/:id/events?limit=N&order=desc` returns newest N in **ASC** order (double-sort: inner DESC LIMIT N, outer ASC). Do NOT regress to `ORDER BY ts ASC LIMIT N` — that gives the oldest N.

### Worker exit codes

- `129` = SIGHUP from normal shutdown after Stop hook → **success**, not error
- `143` = SIGTERM from kill action
- Anything else = real crash → red in UI

### Policy long-poll timeouts

`/policy/decide` blocks indefinitely on `ask` rules when `ttlMs` is not set in `policy.yaml`. If `ttlMs` IS set, the daemon auto-denies after that duration. Hook's curl timeout is 3600s, gateway abort timeout is 3600s. All three (policy ttlMs, hook curl, gateway abort) must be coordinated if changed.

### Temp dir prefix

Workers use `cm-<name>-XXXXXX` via `mkdtempSync`. Don't rename — daemon's `pgrep -f "cm-<name>-"` depends on it for orphan cleanup.

### SQLite migrations

`infra/src/persistence/MigrationRunner.ts` runs numbered migrations on startup. New columns: use `ALTER TABLE … ADD COLUMN` wrapped in try/catch, same pattern as existing migrations.

### Orchestrator = worker with flags

Same worker.ts code. Distinguished by `--persistent` (no auto-shutdown), `--permission-mode bypassPermissions`, `--mcp-config` (orchestrator tools), `--system-prompt-file`. Workers can report back to orchestrator via `worker-mcp/tools/send_message_to_parent.ts`.

## Style notes

- No comments unless *why* is non-obvious. Keep existing comments on: `pty-queue.ts` CR delay, `worktree.ts` realpath dance, `auto-allow.sh`.
- Use `safeStringify()` from `infra/src/util/json.ts` instead of raw `JSON.stringify()` for values that could be non-serializable.
- Use `e instanceof Error ? e.message : String(e)` in catch blocks — never `(e as Error).message`.
- All code/CLI output in English. User web messages may be Turkish.

## Clean Architecture rules

Dependency direction: `contracts/` → `core/` → `infra/` → entrypoints. **Enforced at lint time** via `no-restricted-imports` in `eslint.config.js`. No Node-specific imports in `core/`. Core uses `Clock` port everywhere — never `Date.now()` directly.

Adding new things:
- **HTTP endpoint**: schema in `contracts/src/http.ts` (+ ROUTES entry) → route in `manager/routes/` → register in `manager/daemon.ts`
- **Event type**: enum in `contracts/src/events.ts` → handler in `core/src/use-cases/ProcessWorkerEvent.ts` HANDLERS
- **CLI command**: `manager/cli/commands/<name>.ts` implementing `Command` → register in `registry.ts`
- **MCP tool**: `manager/orchestrator-mcp/tools/` or `manager/worker-mcp/tools/` implementing `McpToolModule` → add to `tool-registry.ts`
- **Infra concern**: port in `core/src/ports/` → impl in `infra/src/<concern>/` → wire in `manager/container.ts`
- **Shared schema**: reusable Zod primitives go in `contracts/src/shared.ts` (e.g. `UnknownRecordSchema`)
- **Manager service**: stateful extracted logic goes in `manager/services/` (e.g. `InterruptCooldownService`)
- **Policy rule**: `POST /api/policy/rule` appends to `~/.claude-mgr/policy.yaml` + reloads; used by web UI "Always allow"

Config is deeply frozen after load. Mutation requires `reloadConfig()` (writes file first, then reloads). Never `Object.assign` on live config.

Node.js strip-only TS mode: don't use parameter properties (`constructor(private x: T)`) — use explicit field + assignment.
