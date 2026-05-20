<picture>
  <source media="(prefers-color-scheme: dark)"  srcset="assets/banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/banner-light.svg">
  <img alt="claude-manager — one operator, one orchestrator, many workers" src="assets/banner-dark.svg">
</picture>

<div align="center">

<br/>

[![status](https://img.shields.io/badge/status-alpha-d97e7e?style=for-the-badge&labelColor=1a1815)](#)
[![runtime](https://img.shields.io/badge/runtime-node%20%C2%B7%20bun-e08964?style=for-the-badge&labelColor=1a1815)](#)
[![ui](https://img.shields.io/badge/ui-react%2018%20%C2%B7%20ink-8eb09a?style=for-the-badge&labelColor=1a1815)](#)
[![pty](https://img.shields.io/badge/pty-only-c4a0d4?style=for-the-badge&labelColor=1a1815)](#)
[![license](https://img.shields.io/badge/license-MIT-e8c574?style=for-the-badge&labelColor=1a1815)](./LICENSE)

</div>

<br/>

> *Command a fleet of background Claude Code workers from a single seat —
> isolated worktrees, supervised live, billed against the subscription you already have.*

<br/>

<table>
<tr>
<td width="80" valign="top" align="center">

`I`

</td>
<td valign="top">

### Why this exists

The interactive `claude` CLI bills against your **Max / Pro subscription**.
The Agent SDK and `claude -p` will draw from a separate credit pool starting
**June 15, 2026**. `claude-manager` is built around a single hard constraint:

</td>
</tr>
</table>

> Every Claude session is driven through an interactive PTY.
> The `-p` flag is never used. Anywhere.

The result is an orchestration layer that lets one human give a single
instruction — *"add tests to the auth module, refactor the session helper,
and update the changelog"* — and have it dispatched as three parallel
workers, each in its own git worktree, each on its own branch, supervised
live, all paid for by the subscription you already have.

<br/>

<table>
<tr>
<td width="80" valign="top" align="center">

`II`

</td>
<td valign="top">

### How it works

A single daemon supervises a singleton **orchestrator** (persistent Claude
session) which dispatches **workers** via an MCP tool. Each worker owns its
own PTY-driven `claude` process inside an isolated git worktree. Everything
streams back to a SQLite event store, then out over SSE to the dashboards.

</td>
</tr>
</table>

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│   user ─── one instruction ───►   TUI · Web · chat                   │
│                                       │                              │
│                                       ▼                              │
│                              ┌──────────────────┐                    │
│                              │   daemon  :7400  │                    │
│                              │   http · sse     │                    │
│                              └────────┬─────────┘                    │
│                                       │  spawns                      │
│                                       ▼                              │
│                              ┌──────────────────┐                    │
│                              │   orchestrator   │   persistent       │
│                              │   (claude · PTY) │   claude session   │
│                              └────────┬─────────┘                    │
│                                       │  mcp__orchestrator__spawn    │
│                ┌──────────────────────┼──────────────────────┐       │
│                ▼                      ▼                      ▼       │
│        ┌──────────────┐       ┌──────────────┐       ┌──────────────┐│
│        │  worker  w1  │       │  worker  w2  │       │  worker  w3  ││
│        │  worktree A  │       │  worktree B  │       │  cwd  scratch││
│        │  claude · PTY│       │  claude · PTY│       │  claude · PTY││
│        └──────┬───────┘       └──────┬───────┘       └──────┬───────┘│
│               │                      │                      │        │
│               └──────────────────────┼──────────────────────┘        │
│                                      ▼                               │
│                              ┌──────────────────┐                    │
│                              │  SQLite  ·  WAL  │   events           │
│                              │                  │   workers          │
│                              │                  │   pending perms    │
│                              └────────┬─────────┘                    │
│                                       │  sse · debounced 80 ms       │
│                                       ▼                              │
│                              TUI · Web · CLI                         │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

<br/>

<table>
<tr>
<td width="80" valign="top" align="center">

`III`

</td>
<td valign="top">

### Features

</td>
</tr>
</table>

<table>
<tr>
<td width="50%" valign="top">

##### Parallel orchestration
A persistent orchestrator decomposes one instruction
into many. Workers run concurrently, each in its own
git worktree on its own branch. Per-worker model
selection — `opus`, `sonnet`, or `haiku`.

</td>
<td width="50%" valign="top">

##### Live observation
SSE-driven dashboard with ~100 ms event latency.
JSONL transcripts parsed into structured tool calls,
tool results, assistant text. Per-worker logs at
`~/.claude-mgr/logs/<id>.log`.

</td>
</tr>
<tr>
<td width="50%" valign="top">

##### Human-in-the-loop policy
YAML rules: `allow`, `deny`, `ask` (long-poll for
approval), or `rewrite` (regex transform of tool
input). Pending requests surface in every interface.
Full audit log at `~/.claude-mgr/audit.jsonl`.

</td>
<td width="50%" valign="top">

##### Cost accounting
Token usage tracked per worker, priced against the
current Anthropic rates for input, output, cache-read,
and cache-create — settled cleanly against your
Max / Pro plan.

</td>
</tr>
<tr>
<td colspan="2" valign="top">

##### Three interfaces, one daemon
`claude-manager` CLI for scripted use  ·  Ink TUI for terminal-native operation  ·  React 18 web UI served by the daemon at `/web/`.

</td>
</tr>
</table>

<br/>

<table>
<tr>
<td width="80" valign="top" align="center">

`IV`

</td>
<td valign="top">

### Who it's for

</td>
</tr>
</table>

<table>
<tr>
<th align="left" width="50%">Built for</th>
<th align="left" width="50%">Not for</th>
</tr>
<tr>
<td valign="top">

— Solo engineers with a Claude Max / Pro plan who want real parallelism.<br/>
— Operators comfortable with daemons, PTYs, git worktrees, YAML policy.<br/>
— Primarily macOS, secondarily Linux.

</td>
<td valign="top">

— Teams looking for a hosted, multi-user platform.<br/>
— Anyone trying to escape an interactive billing model.<br/>
— Pipelines that need headless, `-p`-style invocation.

</td>
</tr>
</table>

<br/>

<table>
<tr>
<td width="80" valign="top" align="center">

`V`

</td>
<td valign="top">

### Roadmap

— Linux-first testing and packaging.<br/>
— Worker capability hints (read-only vs. mutating) for smarter policy defaults.<br/>
— Cross-machine orchestration over the same daemon API.<br/>
— Richer cost / latency analytics in the web dashboard.

</td>
</tr>
</table>

<br/>

<div align="center">
<sub><br/>
<code>claude-manager</code> · <a href="./LICENSE">MIT</a> · © 2026 İbrahim Albayrak<br/>
<sub><i>An atelier for Claude Code.</i></sub>
</sub>
</div>
