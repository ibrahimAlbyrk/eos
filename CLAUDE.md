# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

`Eos` is an orchestration layer over Claude Code. A persistent "orchestrator" agent decomposes a task and spawns worker agents (via MCP tools), each in its own git worktree; workers may spawn sub-workers and consult peers. A daemon supervises everything; a React 18 + Vite web UI, an `eos` CLI, and a native macOS app (WKWebView in `app/`) observe and control it live. State + a full event log live in SQLite (WAL) and stream out over SSE in ~100ms.

## Architecture

Clean-architecture monorepo, dependency direction `contracts → core → infra → entrypoints` (lint-enforced). Each dir is its own package — **NOT a workspace**, install per dir, cross-package imports are relative.

```
contracts/   Zod schemas + TS types — single source of truth for every IPC shape
core/        pure domain · ports · use-cases · services (zero Node imports, uses Clock port)
infra/       adapters for core ports (SQLite, child_process, chokidar, in-process backends)
gateway/     MCP permission broker (Bun)
spawner/     claude-cli (PTY) worker lifecycle: delivery, jsonl ingest, worktree (Node only)
manager/     daemon · CLI · MCP tools (tools/defs/) · backends/ · routes/ · prompts/ · services/
app/ · app/ui/   native macOS shell + the React dashboard (bundled into Eos.app, loaded via eos://app/)
```

**Backend abstraction** is the central concept (`core/src/ports/AgentBackend.ts`). An agent session is reached through an `AgentBackend` adapter with a `BackendDescriptor` + `AgentCapabilities`. Three lanes:
- **`claude-sdk`** — *the default*. Drives `@anthropic-ai/claude-agent-sdk`'s `query()`; in-process, subscription-billed via an OAuth token, live streaming thinking.
- **`claude-cli`** — the original PTY lane (`spawner/worker.ts` over `node-pty`); subscription-billed; the automatic fallback when no subscription credential is present.
- **in-process metered** (`anthropic-api`/`openai`/`codex`) — disabled by default, for future non-Claude providers.

The orchestrator decomposes work and calls MCP tools (`manager/tools/defs/`): `spawn_worker({from})` runs a worker from a **worker definition**, `create_worker` defines one, `list_available_workers`/`list_active_workers` enumerate. System prompts are **assembled per-spawn** (DPI) from the central library at `manager/prompts/`, never static. Every tool call is brokered by the permission gateway (`POST /policy/decide`). User data lives in `~/.eos` (`state.db`, `policy.yaml`, `config.json`, `templates/`, `workers/`). All HTTP endpoints are in `contracts/src/http.ts` ROUTES.

## Build and development

```bash
npm run bootstrap                 # install all 8 package dirs in dependency order (contracts→…→app/ui→root)
npm run lint                      # repo root — enforces dependency direction (per-glob allowlist)
cd manager && npm test            # tsx --test across manager/* suites, core, spawner
cd contracts && npm test          # contracts/ · infra/ · core/ each have their own suite — run separately
cd app/ui && npm test             # web suite (vitest run)
cd app/ui && npm run build        # production build → dist/ (bundled into Eos.app)
bash app/build.sh                 # native macOS app → /Applications/Eos.app
```

Single test: `cd manager && npx tsx --test --test-name-pattern="config" shared/__tests__/config.test.ts` · `cd app/ui && npx vitest run match`.

Preview a prompt: `bash scripts/preview-prompt.sh <orchestrator|worker> [--provider <claude|preset>]` — renders the real assembled system prompt offline (no daemon).

Deploy: `eos build` converges only what changed (content-hash stamps; `--dry-run` to preview). `eos restart` (+`--db` wipes state). `eos help` for the CLI.

## Key design decisions

- **Branch on capabilities, never on backend `kind`.** Read `descriptor.*` / `capabilities.*` — a guard test (`backend-kind-literal-guard`) fails the suite if a `=== "claude-cli"` style comparison reappears.
- **Permission flow.** claude-cli: a `PermissionRequest` hook (`scripts/hooks/auto-allow.sh`) IS the gateway → `POST /policy/decide`. claude-sdk: the SDK's `canUseTool` routes to the same gateway. `AskUserQuestion` is **hard-denied everywhere** — the human-question channel is the orchestrator-only `mcp__orchestrator__ask_user` MCP tool (register-then-poll).
- **Permission mode + tool scope.** A worker's mode (`default`/`acceptEdits`/`plan`/`bypassPermissions`) and its definition's tool allow/deny + `editRegex` gate every call before policy.yaml. Mode is inherited from the parent chain.
- **DPI prompts.** Assembled at the spawn chokepoint from fragments selected by session facts. A fragment's `when` may gate ONLY on session-immutable facts (`role`, `isSubagent`, `isWorktree`, `workerDefinition`) — never on mutable ones (model/effort/permission/backend/git all change at runtime).
- **PTY message delivery goes through `spawner/delivery.ts`** (verified bracketed-paste → composer echo → CR → transcript ACK) — never write raw `text + "\r"`. The claude-sdk lane has no PTY and pushes structured input directly.
- **`spawner/worker.ts` is Node-only** (Bun + node-pty is broken); the **gateway is Bun**; the claude-sdk lane runs in the daemon (Node).
- **`~/.eos` is non-regenerable user data** (manifest in `manager/shared/user-data.ts`) — never `rm`/`mv` it by hand; template deletes are soft (`templates/.trash/`).
- **Don't run `eos build` / `eos restart` while developing Eos** — it restarts the daemon and crashes every running worker. Verify with lint + tests.
- **UI toast notifications.** `notify.info/.warning/.error(message, opts?)` from `app/ui/src/lib/notify.js` — callable from React and non-React code (api client, SSE handlers, stores). Backed by `app/ui/src/state/toastStore.js` (same module-singleton idiom as `ptyPanelStore`); single `<ToastViewport>` in `App.jsx`. Use instead of `alert()`/silent `console.error` for user-relevant feedback. Design: `app/ui/NOTIFICATION_SYSTEM_DESIGN.md`; integration map: `app/ui/NOTIFICATION_USAGE_MAP.md`.

## Style notes

- Comments only when *why* is non-obvious. `safeStringify()` over raw `JSON.stringify()`. `e instanceof Error ? e.message : String(e)` in catch blocks.
- Code/CLI output in English; user web messages may be Turkish. Public repo — no claude.ai session trailer in commits.
- Config is deeply frozen after load; mutate by writing `~/.eos/config.json` then `container.reloadConfig()`. Node strip-only TS: no parameter properties.
