# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

`claude-manager` is an orchestration layer **on top of the interactive `claude` CLI binary** (not the Agent SDK or `claude -p`). A single user message goes to a long-running "orchestrator" agent which decomposes the task and dispatches background worker agents via an MCP tool. A daemon supervises everything; a TUI (Ink) and a web UI (React via babel-standalone) provide live observation and control.

**Hard architectural constraint:** every Claude session runs as an *interactive* PTY-driven process so the user's Max/Pro subscription pays for token usage. **Never use `claude -p`** in any code path — starting June 15 2026 it draws from a separate Agent SDK credit pool. Drive `claude` via `node-pty`, write prompts/messages by `pty.write(text + "\r")`.

## Repository layout

```
gateway/       — MCP server for `--permission-prompt-tool` (dual-mode: standalone or daemon-forward)
spawner/       — worker.ts: one process per Claude session. Owns PTY, hook HTTP server, JSONL tail, worktree lifecycle
manager/       — daemon.ts (HTTP API + SQLite + child supervisor), cli.ts, tui.tsx, orchestrator-mcp.ts, web/
manager/web/   — React 18 UMD + Babel-standalone web UI (no build step). Served by daemon at /web/*
```

Each of `gateway/`, `spawner/`, `manager/` is its own package.json with its own `node_modules`. They are NOT a workspace — install per directory.

## How a request flows end-to-end

1. User types in TUI/web → `POST /orchestrator/message {text}` on daemon
2. Daemon proxies to worker.ts's local HTTP server (`POST http://127.0.0.1:<port>/message`)
3. Worker.ts writes to PTY: `pty.write(text); setTimeout(() => pty.write("\r"), 300)` — splitting is required because bracketed-paste swallows the carriage return otherwise
4. Claude (orchestrator instance) processes, calls `mcp__orchestrator__spawn_worker` autonomously (no permission prompt because orchestrator runs with `--permission-mode bypassPermissions`)
5. The MCP tool's stdio subprocess calls `POST /workers` → daemon `spawn` child process running `worker.ts` with new args
6. New worker boots its own claude via PTY in a git worktree (if `worktreeFrom` given) or plain cwd
7. Worker's claude tries a tool → Claude's permission flow → user's `~/.claude/hooks/auto-allow.sh` PermissionRequest hook fires
8. Hook detects `CLAUDE_MGR_SPAWNED=1` env var → forwards request body to `POST /policy/decide` on daemon → returns daemon's `{behavior, message?, updatedInput?}` decision verbatim, wrapped in `hookSpecificOutput`
9. Worker's JSONL transcript is tailed by worker.ts (chokidar), nested `tool_use`/`tool_result`/`assistant_text` blocks extracted from `message.content[]` and emitted as events to daemon
10. Daemon stores events in SQLite (WAL) and broadcasts `event: change` over SSE
11. TUI and web UI subscribe to `/stream` and refetch on push

## Daemon HTTP surface (127.0.0.1:7400 by default)

- `GET /health` — liveness
- `GET /stream` — Server-Sent Events; pushes on every event/state change
- `GET /workers`, `GET /workers/:id`, `POST /workers`, `DELETE /workers/:id` — worker CRUD. DELETE wipes events + pending too (clean slate)
- `GET /workers/:id/events?since=<ts>&limit=<n>` — events query (newest N, returned ASC)
- `POST /workers/:id/message {text}` — proxy a message to the worker's PTY
- `POST /workers/:id/events {type, payload}` — workers push events here
- `POST /orchestrator/start` — spawn singleton orchestrator if not running
- `POST /orchestrator/message {text}` — auto-spawns if needed, then proxies
- `POST /policy/decide {worker_id, tool_name, input, tool_use_id?}` — gateway/hook calls this; long-polls when policy says `ask` until human resolves or `ttlMs` fires
- `GET /pending` — pending permission requests
- `POST /pending/:id/decision {decision: "allow"|"deny", reason?, updatedInput?}` — CLI/UI resolves a pending
- `GET /web/*` — static file serving for the web UI

## Commands

The CLI is installed as a symlink: `~/.local/bin/claude-manager → manager/bin/claude-manager` (a bash wrapper that runs `node --experimental-strip-types manager/cli.ts`).

```bash
claude-manager daemon start|stop|status      # daemon lifecycle (writes ~/.claude-mgr/daemon.pid)
claude-manager web                            # ensures daemon is up, opens browser to /web/
claude-manager tui                            # launch Ink TUI (uses node_modules/.bin/tsx, not bun)
claude-manager chat <message...>              # send a message to the orchestrator
claude-manager list                           # list workers
claude-manager spawn --worktree-from <repo> --prompt "..." [--with-gateway] [--branch <b>]
claude-manager spawn --cwd <dir> --prompt "..."
claude-manager show <id>                      # worker detail + recent events
claude-manager logs <id> [-f]                 # tail the worker's stdout/stderr log file
claude-manager kill <id>                      # SIGTERM + DB row + events removed
claude-manager pending                        # list pending permission requests
claude-manager approve <pending-id> [--rewrite '<json>']
claude-manager deny <pending-id> [--reason '<text>']
```

To restart the daemon after editing daemon.ts / orchestrator-mcp.ts / worker.ts:

```bash
claude-manager daemon stop
sleep 2
pkill -9 -f "manager/daemon.ts|spawner/worker.ts|orchestrator-mcp.ts|claude --settings"
sleep 2
rm -f ~/.claude-mgr/state.db* ~/.claude-mgr/daemon.pid   # if you want a clean DB
claude-manager daemon start &
```

Browser cached JSX/CSS will not pick up edits to `manager/web/*` until you **hard-refresh (Cmd+Shift+R)**. The daemon serves with `cache-control: no-store` but browsers still cache aggressively.

## Critical decisions and gotchas (read before editing)

### Runtime split: Node vs Bun

- **TUI and worker.ts run under Node only** because Bun + `node-pty` is broken: `pty.onData(...)` never fires under Bun (Bun's N-API doesn't deliver the libuv stream events node-pty expects). Verified empirically.
- The gateway MCP server runs under **Bun** (faster startup as a stdio child of Claude). Its `mcp.json` references `/Users/ibrahimalbyrk/.local/bin/bun` by absolute path because Claude's PATH inheritance is unreliable.

### Permission flow: hook-as-gateway, NOT `--permission-prompt-tool`

Claude's permission resolution prefers the interactive TUI prompt over `--permission-prompt-tool` MCP whenever a `PermissionRequest` hook is configured — even one that exits silently. This means the MCP gateway flag is effectively bypassed for any user with hooks set up.

**The working pattern is to make the hook itself the gateway.** User's `~/.claude/hooks/auto-allow.sh` checks `CLAUDE_MGR_SPAWNED` env var (set by worker.ts when spawned by the daemon), and when set, forwards the request to `POST /policy/decide` and returns the daemon's decision verbatim. Output shape (empirically verified):

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "allow|deny", "message"?: "..." },
    "updatedInput"?: { ... }     // sibling of `decision`, NOT inside it (inverse of MCP contract)
  }
}
```

`--with-gateway` flag on worker.ts still wires up the MCP `--permission-prompt-tool` for defense in depth, but the hook decides first.

### Orchestrator is a worker (singleton)

- Fixed `worker_id = "orchestrator"`. Same worker.ts code path. Distinguished by:
  - `--persistent` flag → skips `scheduleShutdown()` on Stop/SessionEnd hooks (stays IDLE between turns)
  - `--system-prompt-file manager/orchestrator-prompt.md` → role description
  - `--mcp-config <orchestrator-mcp.json>` → exposes `spawn_worker`/`list_workers`/`get_worker`/`kill_worker`/`list_pending_permissions`
  - `--permission-mode bypassPermissions` → its MCP tool calls don't hit any permission flow
- DELETE on orchestrator works the same as any worker; UI's spawn-orchestrator button (left panel when no orchestrator present) calls `/orchestrator/start` to recreate it

### Worker.ts environment requirements

The PTY environment for claude **must** include three vars when daemon-aware:

```ts
CLAUDE_MGR_SPAWNED=1                    // tells the auto-allow.sh hook to delegate
CLAUDE_MGR_WORKER_ID=<id>               // so daemon events log under correct worker
CLAUDE_MGR_DAEMON_URL=http://127.0.0.1:7400
```

Missing any of these falls through to default auto-allow / silent-exit and the gateway loop breaks.

### JSONL parsing — nested content blocks

Claude Code transcripts wrap tool_use and tool_result blocks **inside** `e.message.content[]`. The naive top-level `e.type === "tool_use"` check misses every tool call. Worker.ts iterates both assistant and user message content arrays — see `readNew()` in spawner/worker.ts. Without this, the UI's activity feed shows assistant text but no tool calls.

### macOS `/tmp` symlink

`/tmp` is a symlink to `/private/tmp` on macOS. Claude writes its session JSONL under `~/.claude/projects/<encoded-realpath-cwd>/<session-id>.jsonl`. Worker.ts must call `realpathSync(cwd)` before computing the encoded directory or chokidar watches a path that doesn't exist. Encoding rule: replace every char not in `[a-zA-Z0-9_-]` with a single `-`.

### SQLite migration

Workers table has `parent_id` and `model` columns added after initial schema. Daemon attempts `ALTER TABLE workers ADD COLUMN` on startup wrapped in try/catch to support older DBs. If you add columns, follow the same pattern.

### Worker exit codes

- `0` → claude exited cleanly on its own (rare)
- `129` → SIGHUP from worker.ts's normal shutdown after Stop hook (this is **success**)
- `143` → SIGTERM from `DELETE /workers/:id` (kill action)
- Anything else → real crash; surface as red in UI

CLI/TUI display labels them as `completed` / `killed` / `exit=N` so the user doesn't read 129 as an error.

### Policy gateway long-polls

When policy.yaml's rule says `ask`, the daemon's `/policy/decide` blocks the HTTP request until a human approves via `/pending/:id/decision` OR `ttlMs` (default 30000) elapses and it auto-denies. The hook's curl timeout is 90s to comfortably exceed TTL. Don't reduce these without coordinating.

### Live-update pipeline

SSE pushes are debounced 80ms on the web client and trigger a single refetch of `/workers` + `/pending` + per-worker `/events`. The 4-second fallback polling is a safety net only — under normal operation, every state transition appears in the UI within ~100ms of the daemon writing it.

`/workers/:id/events?limit=N` returns the **newest** N events in ASC order (uses `SELECT * FROM (SELECT … ORDER BY ts DESC LIMIT N) ORDER BY ts ASC`). Earlier code used `ORDER BY ts ASC LIMIT N` which gave the *oldest* N — a recent fix; do not regress.

## Where to find what

- Worker lifecycle, PTY handling, hook HTTP server, worktree creation/teardown: `spawner/worker.ts`
- Daemon HTTP routes, SQLite schema, SSE broadcast, policy engine, orchestrator spawn: `manager/daemon.ts`
- Orchestrator MCP tools (spawn_worker etc): `manager/orchestrator-mcp.ts`
- Orchestrator system prompt: `manager/orchestrator-prompt.md`
- Permission policy rules: `manager/policy.example.yaml` (default) and `~/.claude-mgr/policy.yaml` (user override, loaded first)
- Web UI live data layer, event mapping, ID→name substitution: `manager/web/data.jsx`
- Web UI components (Topbar, AgentsPanel, CenterColumn, DetailsPanel, EventRow): `manager/web/parts.jsx`
- CLI commands: `manager/cli.ts`
- Persistent state: `~/.claude-mgr/state.db` (SQLite WAL), `~/.claude-mgr/logs/<worker-id>.log`, `~/.claude-mgr/daemon.pid`

## Style notes

- Default to no comments. Only write comments when *why* is non-obvious (race-condition workarounds, undocumented Claude internals, etc.). The `worker.ts` JSONL parsing and the `auto-allow.sh` hook delegation each have such comments — keep them.
- All in-codebase strings, comments, and CLI output are in English. The user's TUI/web messages may be Turkish; the orchestrator's system prompt explicitly instructs it to respond terse and English by default.
- Per-worker temp dirs use the pattern `cm-<name>-XXXXXX` (via `mkdtempSync`). Don't rename this prefix — daemon's force-kill `pgrep -f "cm-<name>-"` depends on it for orphan cleanup.
