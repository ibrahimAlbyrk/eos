<!-- header banner: auto dark/light -->
<picture>
  <source media="(prefers-color-scheme: dark)"  srcset="assets/eos-banner-aurora-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/eos-banner-aurora-light.svg">
  <img alt="Eos — orchestrate Claude Code agent swarms from a single seat" src="assets/eos-banner-aurora-dark.svg" width="100%">
</picture>

<div align="center">

![status](https://img.shields.io/badge/status-alpha-e8a06e?style=for-the-badge&labelColor=1a1a1a)
![platform](https://img.shields.io/badge/macOS-primary-6ea4e8?style=for-the-badge&labelColor=1a1a1a)
![runtime](https://img.shields.io/badge/runtime-node%20%C2%B7%20bun-6ea4e8?style=for-the-badge&labelColor=1a1a1a)
![license](https://img.shields.io/badge/license-MIT-6ea4e8?style=for-the-badge&labelColor=1a1a1a)

</div>

<div align="center">

### One instruction in. A swarm of Claude Code agents out.

Each in its own git worktree. Working in parallel. Streamed to you live.<br/>
**All on the Max / Pro subscription you already pay for.**

</div>

```bash
curl -fsSL https://raw.githubusercontent.com/ibrahimAlbyrk/eos/main/install.sh | bash
```

<div align="center">

**Real things, built one-shot by a swarm:** &nbsp; [▶ a playable RTS — 39 agents](https://playmore.world/#game/9eb83f07-85d0-46ff-900f-30aaa446a5ae) &nbsp;·&nbsp; [a 64k-word game bible — 12 agents](examples/WITHERREACH-GDD.md) &nbsp;·&nbsp; [browser DOOM w/ multiplayer](https://185.249.197.74.sslip.io/)

</div>

<!-- ╔══ ADD HERO MEDIA HERE ════════════════════════════════════════════════╗
     Record ~10–15s of the live split-screen dashboard with 3–4 workers
     streaming at once. Save it to assets/eos-dashboard.gif and uncomment:
     ╚═══════════════════════════════════════════════════════════════════════╝
<p align="center"><img src="assets/eos-dashboard.gif" alt="Eos — four agents streaming live in split-screen" width="100%"></p>
-->

<br/>

<!-- divider -->
<picture><source media="(prefers-color-scheme: dark)" srcset="assets/eos-divider-dark.svg"><img src="assets/eos-divider-light.svg" width="100%"></picture>

## Quickstart

The one-liner above installs the toolchain (Node · Bun · Xcode CLT · `claude`), clones the source to `~/eos`, builds, and launches the macOS app. Sign in once with `claude` and you're set — rebuild anytime with **`eos build`**.

<details>
<summary><b>Options · manual install · requirements</b></summary>

<br/>

The installer is idempotent — safe to re-run. It auto-installs anything missing, clones to `~/eos`, installs all 8 package dirs, links `eos`, fixes your `PATH`, then runs `eos build`.

| Override | Default | Purpose |
| :------- | :------ | :------ |
| `EOS_DIR` / `--dir DIR` | `~/eos` | where the source is cloned |
| `EOS_BRANCH` / `--branch B` | `main` | branch to track |
| `--no-build` | — | set up only; run `eos build` yourself |

Pass flags through the pipe with `-s --`, e.g. `… | bash -s -- --no-build`.

**Manual, from a clone:**

```bash
git clone https://github.com/ibrahimAlbyrk/eos ~/eos && cd ~/eos
npm run bootstrap                  # install all 8 package dirs in order (NOT a workspace)
bash scripts/bootstrap.sh --link   # symlink ~/.local/bin/eos
eos build                          # compile web + macOS app, start the daemon
```

**Needs:** macOS (primary; Linux works, minus the app) · Node 22+ · Bun · git · the `claude` CLI signed in to a Max / Pro plan · a writable `/Applications`. The installer provides all of it.

</details>

<br/>

## How it works

You talk to a persistent **orchestrator**. It breaks your instruction into pieces and spawns **workers** — each in its own git worktree, on its own branch, free to spawn sub-workers or [consult its peers](docs/PROMPTING.md). A **daemon** supervises everything; a **permission gateway** brokers every tool call. State and a full event log live in SQLite and stream to every UI over SSE in ~100 ms.

```
        you ─ "add tests, refactor the session helper, update the changelog"
                                   │
                  Web UI   ·   eos CLI   ·   macOS app
                                   │  http · sse
                      ╭───────────────────────────╮       ╭──────────────────╮
                      │      daemon · :7400        │ ────▶ │   SQLite · WAL   │
                      │   http · sse · event log   │       │  events · state  │
                      ╰─────────────┬──────────────╯       ╰──────────────────╯
                                    │  spawns persistent sessions
                      ╭───────────────────────────╮
                      │       orchestrator         │   decomposes one
                      │   persistent · long-lived  │   instruction → many
                      ╰─────────────┬──────────────╯
                                    │  spawn_worker (MCP)
              ╭─────────────────────┼─────────────────────╮
              ▼                     ▼                     ▼
        ┌───────────┐         ┌───────────┐         ┌───────────┐
        │ worker w1 │         │ worker w2 │         │ worker w3 │
        │ worktree  │         │ worktree  │         │ worktree  │
        └─────┬─────┘         └─────┬─────┘         └─────┬─────┘
              │       peers may consult one another       │
              ╰─────────────── every tool call ───────────╯
                                    │
                      ╭───────────────────────────╮
                      │       gateway · Bun        │   allow · deny ·
                      │     permission broker      │   ask-human · rewrite
                      ╰───────────────────────────╯
```

> **Why subscription, not credits?** Claude's interactive plan (Max / Pro) and the metered API / `claude -p` pool are two different wallets. Eos drives every session against the **subscription** one — by default through the in-process Agent SDK, falling back to an interactive PTY when no subscription credential is present. Never the metered pool. Point it at a big job, it fans out into a swarm, and the bill stays the flat subscription you're already paying.

<br/>

<!-- divider -->
<picture><source media="(prefers-color-scheme: dark)" srcset="assets/eos-divider-dark.svg"><img src="assets/eos-divider-light.svg" width="100%"></picture>

## What you get

| | |
| :-- | :-- |
| **Parallel swarms** | One instruction → many workers, each in its own worktree + branch. Pick model (`opus` · `sonnet` · `haiku` · `fable`) and effort per worker. Workers spawn sub-workers. |
| **Dynamic workers** | Not a fixed roster. Beyond the built-ins, the orchestrator **defines new workers at runtime** — `create_worker` sets role, model, tool fences, permission mode, even `extends` inheritance — then runs them with `spawn_worker({from})`. It's how 12 bespoke domain-experts staffed the Witherreach run. |
| **Peer collaboration** | Workers consult one another directly — `ask_peer` / `respond_to_peer` / `list_peers` — instead of routing every question back through the orchestrator. |
| **Live dashboard** | Every session streamed at ~100 ms: tool calls, results, thinking timer, reports, a task tray, background-activity monitor. Per-worker logs at `~/.eos/logs/`. |
| **Split-screen** | Watch up to **4 agents at once** (2-up · 1+2 · 2×2). Click a pane to focus; the header, composer, and side panel follow it — steer one without losing the rest. |
| **In-app Git** | Branches, deterministic push / fast-forward pull (no agent turn spent), diff + commit viewers, a hunk-level conflict resolver, PRs via `gh`, a **Try** stack, and `integrate_workers` to merge a swarm's branches. |
| **Policy gateway** | YAML decides every tool call: `allow` · `deny` · `ask` (long-poll a human, no timeout) · `rewrite`. Per-worker permission modes, inline approval banners, full audit log. |
| **Assembled prompts (DPI)** | System prompts composed per-spawn from a central library, selected by role and context — never hardcoded. Project memory + reusable templates are first-class. |
| **Three ways in, one daemon** | React 18 web UI · `eos` CLI · native macOS app (WKWebView). ⌘K palette, session resume that survives daemon restarts, per-worker token pricing (display-only). |

<!-- Optional screenshots — drop files in assets/ and uncomment any you like:
<p align="center"><img src="assets/eos-split-screen.png" alt="Split-screen — four live transcripts" width="100%"></p>
<p align="center"><img src="assets/eos-git.png" alt="In-app git — diff and conflict resolver" width="100%"></p>
<p align="center"><img src="assets/eos-policy.png" alt="Policy gateway — a permission approval banner" width="100%"></p>
-->

<br/>

<!-- divider -->
<picture><source media="(prefers-color-scheme: dark)" srcset="assets/eos-divider-dark.svg"><img src="assets/eos-divider-light.svg" width="100%"></picture>

## Seen in the wild

The first two came from **a single prompt, no follow-ups.** Eos planned the work, spun up the agents, and delivered.

**🎮 A playable RTS.** &nbsp; One prompt → **39 agents in parallel** → a working Age-of-Empires-style real-time strategy game. &nbsp; **[▶ Play it](https://playmore.world/#game/9eb83f07-85d0-46ff-900f-30aaa446a5ae)**

**📖 Witherreach — a 64,000-word game bible.** &nbsp; One prompt → **12 expert agents** consulting each other (narrative · survival · RPG/combat · tech/co-op · market) → a complete dark-fantasy survival-RPG design doc where the corruption killing the world is your only source of power. 21 chapters. &nbsp; **[Read the GDD](examples/WITHERREACH-GDD.md)**

**👾 DOOM-TS — browser DOOM with multiplayer.** &nbsp; A multi-turn build → a from-scratch raycaster FPS in TypeScript: engine, AI, 9 weapons, 6 original levels — then online co-op + PvP with client-side prediction and lag compensation, a room browser, offline single-player, deployed live. &nbsp; **[▶ Play it](https://185.249.197.74.sslip.io/)** &nbsp;·&nbsp; [source](https://github.com/ibrahimAlbyrk/doom-ts)

<br/>

## How the orchestrator briefs its workers

A sub-agent is only as good as its brief. Eos's orchestrator writes each worker's prompt the way a senior engineer writes a handoff — outcome first, then only the facts the worker can't cheaply discover. *"improve the message queue"* becomes *"add `DELETE /workers/:id/queue` that clears undispatched messages; `npm test` passes; returns `{removed:n}`."* Fan-out is disciplined, not eager: the default is **one** worker, because a wrong split bakes a bad assumption in N times.

→ The full method — disjoint ownership, contract-first swarms, adversarial re-checks, the three-token reporting protocol — lives in **[docs/PROMPTING.md](docs/PROMPTING.md)**.

<br/>

<!-- divider -->
<picture><source media="(prefers-color-scheme: dark)" srcset="assets/eos-divider-dark.svg"><img src="assets/eos-divider-light.svg" width="100%"></picture>

## The `eos` CLI

One daemon, one binary. `eos help` lists everything.

| Command | What it does |
| :------ | :----------- |
| `start` · `stop` · `restart` | Run, halt, or restart the daemon (`restart --db` also wipes state). |
| `build` · `doctor` · `status` | Converge the deploy · sanity-check the environment · reachability. |
| `orchestrator new` · `chat <msg>` | Spawn a persistent orchestrator · send it an instruction. |
| `spawn` | Launch a single worker directly (`--worktree-from` · `--prompt` · `--model`). |
| `ls` · `show <id>` · `logs <id> -f` | List workers · inspect one · tail its log. |
| `kill <id>` · `perm ok\|no <id>` | Terminate a worker · approve or deny a pending permission. |
| `config print` · `prompts validate` · `hooks` | Dump merged config · validate the prompt library · install the gateway hook. |

<br/>

## Who it's for

| Built for | Not for |
| :-------- | :------ |
| Solo engineers on a Claude Max / Pro plan who want real parallelism. | Teams wanting a hosted, multi-user platform. |
| Operators comfortable with daemons, PTYs, git worktrees, and YAML policy. | Anyone trying to escape an interactive billing model. |
| macOS first, Linux second. | Pipelines that need headless, `-p`-style invocation. |

<details>
<summary><b>Project layout</b></summary>

<br/>

Clean-architecture monorepo — `contracts` → `core` → `infra` → entrypoints, dependency direction enforced at lint time. Each dir installs on its own; **not** an npm workspace.

```
contracts/   Zod schemas + types — single source of truth for every IPC shape
core/        pure domain · ports · use-cases · services (zero Node imports)
infra/       adapters for core ports — SQLite, child_process, chokidar, …
gateway/     MCP permission broker (runs on Bun)
spawner/     worker.ts — PTY lifecycle, verified delivery, JSONL ingest (Node only)
manager/     daemon · CLI · MCP tools · routes · prompt library
app/         native macOS shell — main.swift WKWebView → Eos.app
app/ui/      React 18 + Vite dashboard, bundled into Eos.app
```

User data lives in **`~/.eos`** — `state.db`, `policy.yaml`, `config.json`, `templates/`, `logs/`, startup `backups/`. Non-regenerable; never destroyed by tooling.

</details>

<br/>

## Roadmap

**Alpha** — single-author, in daily use, moving fast. Solid today: multi-orchestrator control, worker↔worker swarms, the live dashboard, in-app git (push / pull · PR · conflict resolver · Try · integrate), the policy gateway, per-spawn prompt assembly, session resume, and the native macOS app.

Next: **deterministic workflows** (the Workflows tab is still a stub) · **dynamic loops** — goal-driven iteration where the orchestrator spawns, checks the result, re-plans, and re-spawns until the goal is met, the adaptive counterpart to fixed workflows · an **in-app project explorer** · **more backends** (Deepseek · Kimi · Codex · local LLMs, same orchestration layer) · **Linux & Windows** first-class.

<br/>

---

<div align="center">
<sub>
<b>Eos</b> &nbsp;·&nbsp; <a href="./LICENSE">MIT</a> &nbsp;·&nbsp; © 2026 İbrahim Albayrak<br/>
<i>An atelier for Claude Code.</i>
</sub>
</div>
