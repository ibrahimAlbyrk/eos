<div align="center">

# claude-manager

**Command a fleet of background Claude Code workers from a single seat.**

One operator. One orchestrator. Many isolated worktrees, running in parallel.

<sub>Live dashboard · CLI · Ink TUI · permission policy engine · SQLite event store</sub>

<br/>

[![status](https://img.shields.io/badge/status-alpha-d97e7e?style=flat-square)](#)
[![runtime](https://img.shields.io/badge/runtime-node%20%2B%20bun-1a1815?style=flat-square)](#)
[![ui](https://img.shields.io/badge/ui-react%2018%20%C2%B7%20ink-8eb09a?style=flat-square)](#)
[![license](https://img.shields.io/badge/license-MIT-e8c574?style=flat-square)](./LICENSE)

</div>

---

## Why this exists

The interactive `claude` CLI bills against your **Max / Pro subscription**.
The Agent SDK and `claude -p` will draw from a separate credit pool starting
June 15 2026. `claude-manager` is built around a single hard constraint:

> Every Claude session is driven through an interactive PTY.
> The `-p` flag is never used. Anywhere.

The result is an orchestration layer that lets one human give a single
instruction — *"add tests to the auth module, refactor the session helper,
and update the changelog"* — and have it dispatched as three parallel
workers, each in its own git worktree, each on its own branch, supervised
live, all paid for by the subscription you already have.

---

## How it works

```
┌────────────────────────────────────────────────────────────────────┐
│  user                                                              │
│  └─ types one instruction (TUI / Web / `chat` CLI)                 │
│        │                                                           │
│        ▼                                                           │
│  ┌──────────────┐    POST /orchestrator/message                    │
│  │   daemon     │◄─────────────────────────────┐                   │
│  │  127.0.0.1   │                              │                   │
│  │   :7400      │   PTY write                  │                   │
│  └──────┬───────┘──────────────────────┐       │                   │
│         │ spawns                        ▼      │                   │
│         │                       ┌───────────────┐                  │
│         │                       │ orchestrator  │  (singleton      │
│         │                       │   worker      │   persistent     │
│         │                       └──────┬────────┘   claude)        │
│         │ mcp__orchestrator__spawn_worker                          │
│         │       │                                                  │
│         ▼       ▼                                                  │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐                         │
│  │ worker w1 │ │ worker w2 │ │ worker w3 │  ← node-pty + claude    │
│  │  worktree │ │  worktree │ │  cwd      │                         │
│  │  branch A │ │  branch B │ │  scratch  │                         │
│  └─────┬─────┘ └─────┬─────┘ └─────┬─────┘                         │
│        │             │             │                               │
│        │ JSONL tail · hook events · exit codes                     │
│        ▼             ▼             ▼                               │
│              ┌─────────────────────┐                               │
│              │  SQLite (WAL)       │                               │
│              │  events · workers   │                               │
│              │  pending_perms      │                               │
│              └──────────┬──────────┘                               │
│                         │                                          │
│                         │ SSE /stream  (debounced 80ms)            │
│                         ▼                                          │
│              TUI (Ink) · Web UI (React 18) · CLI                   │
└────────────────────────────────────────────────────────────────────┘
```

| Concern              | Where it lives           | Notes                                                                 |
| -------------------- | ------------------------ | --------------------------------------------------------------------- |
| HTTP API, SSE, SQLite | `manager/daemon.ts`     | Single Node process. WAL journaling. Cost tracking per model.         |
| Worker process       | `spawner/worker.ts`      | One per Claude session. Owns the PTY, tails JSONL, creates worktrees. |
| Orchestrator MCP     | `manager/orchestrator-mcp.ts` | `spawn_worker`, `list_workers`, `get_worker`, `kill_worker`.     |
| Permission gateway   | `gateway/server.ts`      | MCP `decide` tool. Defense-in-depth alongside the hook gateway.       |
| Policy engine        | `manager/policy.example.yaml` | YAML rules: `allow` / `deny` / `ask` / `rewrite`. First match wins. |
| TUI                  | `manager/tui.tsx`        | Ink + React, terminal-native.                                         |
| Web UI               | `manager/web/`           | React 18 + Vite. "Atelier" cream/clay palette.                        |

---

## Features

**Parallel orchestration**
- Single instruction is decomposed by a persistent orchestrator agent.
- Workers run concurrently in isolated git worktrees on their own branches.
- Per-worker model selection (`opus` / `sonnet` / `haiku`).

**Live observation**
- SSE-driven dashboard with ~100 ms event latency.
- JSONL transcripts parsed into structured tool calls, results, assistant text.
- Per-worker logs at `~/.claude-mgr/logs/<id>.log`.

**Human-in-the-loop policy**
- YAML rules: allow, deny, ask (long-poll for human approval), or rewrite input.
- Pending requests surface in TUI, Web, and CLI. Approve, deny, or rewrite the
  tool input before it executes.
- Audit log of every decision at `~/.claude-mgr/audit.jsonl`.

**Cost accounting**
- Token usage tracked per worker, priced against current Anthropic rates for
  input / output / cache-read / cache-create.

**Three interfaces, one daemon**
- `claude-manager` CLI for scripted use.
- Ink TUI for terminal-native operation.
- React web UI served by the daemon at `/web/`.

---

## Who it's for

| If you are…                                                                   | …this is built for you |
| ----------------------------------------------------------------------------- | :--------------------: |
| A solo engineer with a Claude Max / Pro plan who wants real parallelism       | yes                    |
| Comfortable with daemons, PTYs, git worktrees, and editing YAML policy        | yes                    |
| Working primarily on macOS                                                    | yes                    |
| Looking for a hosted multi-user platform                                      | no                     |
| Trying to avoid an interactive billing model                                  | no                     |

---

## Requirements

- macOS (Linux likely works; not actively tested)
- **Node.js 22+** — runs the daemon, TUI, and workers (`--experimental-strip-types`)
- **Bun** — runs the MCP gateway only. Absolute path expected at `~/.local/bin/bun`
- **claude** CLI on `$PATH`, authenticated against an interactive subscription
- A `PermissionRequest` hook at `~/.claude/hooks/auto-allow.sh` that delegates
  to `$CLAUDE_MGR_DAEMON_URL/policy/decide` when `CLAUDE_MGR_SPAWNED=1` is set

---

## Install

```bash
git clone <this-repo> claude-manager
cd claude-manager

# per-package installs — this is not a workspace
( cd gateway  && bun install )
( cd spawner  && bun install )
( cd manager  && bun install )
( cd manager/web && npm install && npm run build )

# CLI symlink
mkdir -p ~/.local/bin
ln -sf "$PWD/manager/bin/claude-manager" ~/.local/bin/claude-manager
```

Restart paths so `claude-manager` resolves, then:

```bash
claude-manager daemon start
claude-manager web              # opens the dashboard in your browser
```

---

## Commands

```text
daemon  start | stop | status      lifecycle for the orchestrator daemon
web                                ensure daemon is up, open dashboard
tui                                launch the Ink TUI
chat    <message…>                 send a message to the orchestrator

list                               list all workers
spawn   --worktree-from <repo> --prompt "…" [--branch <b>] [--model <m>]
spawn   --cwd <dir>           --prompt "…"
show    <id>                       worker detail + last 50 events
logs    <id> [-f]                  tail worker log
kill    <id>                       SIGTERM + remove

pending                            pending permission requests
approve <pending-id> [--rewrite '<json>']
deny    <pending-id> [--reason "…"]
```

`CLAUDE_MGR_URL` overrides the daemon address (default `http://127.0.0.1:7400`).

---

## Daemon HTTP surface

| Method | Path                                  | Purpose                                          |
| ------ | ------------------------------------- | ------------------------------------------------ |
| GET    | `/health`                             | liveness                                         |
| GET    | `/stream`                             | SSE; pushes on every event / state change        |
| GET    | `/workers`                            | list                                             |
| GET    | `/workers/:id`                        | detail                                           |
| POST   | `/workers`                            | spawn                                            |
| DELETE | `/workers/:id`                        | terminate + clean events + pending               |
| GET    | `/workers/:id/events?since&limit`     | newest N events, returned ASC                    |
| POST   | `/workers/:id/message`                | proxy a message to the worker's PTY              |
| POST   | `/orchestrator/start`                 | spawn singleton orchestrator                     |
| POST   | `/orchestrator/message`               | auto-spawn + proxy                               |
| POST   | `/policy/decide`                      | gateway / hook entry. Long-polls on `ask`.       |
| GET    | `/pending`                            | unresolved permission requests                   |
| POST   | `/pending/:id/decision`               | `allow` / `deny`, optional `updatedInput`        |
| GET    | `/web/*`                              | static UI                                        |

---

## Permission policy

Edit `~/.claude-mgr/policy.yaml` (user override), or fall back to
`manager/policy.example.yaml`. Rules are evaluated top-to-bottom; first
match wins. Unmatched calls fall through to `default`.

```yaml
default: allow
ttlMs: 30000

rules:
  - { tool: Bash, command: "^\\s*rm\\s+-[rRf]+\\s+/(\\s|$)", action: deny,
      reason: "rm -rf / blocked" }

  - { tool: Bash, command: "(^|\\s)curl(?!.*--max-time)", action: rewrite,
      rewriteFrom: "(^|\\s)curl\\b", rewriteTo: "$1curl --max-time 10" }

  - { tool: Bash, command: "git\\s+push", action: ask }
```

Actions:

| Action    | Behaviour                                                                 |
| --------- | ------------------------------------------------------------------------- |
| `allow`   | Tool runs unchanged.                                                      |
| `deny`    | Tool blocked, `reason` returned to the worker.                            |
| `ask`     | Request enters the pending queue; daemon long-polls until human resolves. |
| `rewrite` | Input transformed via regex before the tool runs.                         |

---

## Roadmap

- ...

---

## License

[MIT](./LICENSE) · © 2026 İbrahim Albayrak
