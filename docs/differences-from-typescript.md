# Where the Rust app behaves differently from the 0.1.x app

The Rust app is meant to answer exactly as the 0.1.x app — the TypeScript app (a Node daemon behind
an Electron window) that users upgrade from — does: the same routes, the same answers, the same files on disk. The dashboard,
the released iPhone app and paired Macs depend on that, and a replay of recorded answers checks
it on every change. This page lists every place where the Rust app does something else **on
purpose**, so the owner can decide on each one.

Sources: the reason recorded beside each accepted difference of the replay
(`fixtures/wire/rust-differences.toml`), notes in the crates' documentation, tests named after a
fixed bug, the owner's decisions of 2026-11-11, and what came up while closing the last items of
the port. "0.1.x" always means that TypeScript app.

Part 2 lists behaviour that was copied on purpose although it looks wrong, so that nothing
changes there without a decision.

## Part 1: deliberate differences

### The app as a whole

| What | 0.1.x | Rust | Why |
|---|---|---|---|
| How the window reaches the core | A local HTTP server on a port, used by the window, the CLI and the agents | One program: the window's requests are answered inside it, with no port | No background process to keep alive and no port to protect (the owner's plan). |
| Browser-safety checks (CORS, `Origin` and `Host` checks against DNS rebinding) | Present | Gone | They protect a server listening on a port. There is none: only the app's own window and its two gateways (the phone, paired Macs) can reach the core. |
| Compressed answers (gzip), CORS headers | Sent | Not sent | Both belong to an HTTP server. Inside one program there is nothing to compress or to allow. |
| `HEAD` requests | A 404 answer to a `HEAD` carried a JSON body | No body | HTTP never carries a body on a `HEAD` answer. |
| A request body that is not JSON | 500, with the JavaScript parser's message | 400 `invalid request: body is not valid JSON` | It is the caller's mistake, and says so. |
| Wording of "invalid request" answers | Every wrong field listed | A type mismatch names the first wrong field (broken rules are all listed); a bad choice of kind reads "Invalid enum value … received 'x'"; `null` for an optional field counts as absent | The bodies are read with typed parsers. The dashboard shows the text but never reads it. |
| Long lists (more than 1,000 rows: a transcript page, the subagent list) | Sent at once, with a weak `ETag` | Sent in slices as the reader takes them, without the `ETag` | A huge list is never held in memory twice. An `ETag` needs the whole body first, and inside one program nothing revalidates. |
| The build stamp a paired Mac reads (`apiStamp`) | The TypeScript build's | The Rust build's own | A Mac of one kind then loads the other Mac's own dashboard instead of driving it with a mismatched one. |
| `/metrics`, the `eos` runtime CLI, the stdio MCP servers, the launchd agent | Present | Not in the Rust app | They served or supervised a background daemon. There is none. |
| `POST /workers/:id/events` | Served (the terminal-driven agent lane posted its rows there) | Not served | That lane is gone: every agent reports through its own session. |
| The model list before it was ever fetched (no `models.json` yet) | `GET /api/ui-config` waited for the first fetch, up to 3 s | Answers at once with an empty list and fetches in the background; the dashboard's own refresh when it opens brings the list | Nothing waits on the network to draw the window. |
| Closing the window | The daemon kept running in the background, with a tray icon | The app stays in the Dock; quitting stops everything, agents included | Owner's decision D8; no tray (its Lock Screen and Install Screen Saver… items are in the Eos menu). So the phone link and the nightly dream work only while the app runs. |
| Windows | Supported | Not yet; Windows stays on the last TypeScript release | Owner's decision D2. |

### The window

| What | 0.1.x | Rust | Why |
|---|---|---|---|
| Permission requests of the dashboard (camera, microphone, notifications, clipboard reading, geolocation) | Granted, except the old synchronous clipboard read; geolocation only to the dashboard's own top frame | Every request refused, in every view | The dashboard asks for none of them: the location comes from the location helper through the core, banners from the shell. Browser tabs and artifact views refused them in 0.1.x too. |
| A right-click in a browser tab, an artifact view or a frame of the raw origin (file previews, visual answers' apps, the PDF viewer) | No menu at all | Chromium's own menu, trimmed to editing, copying and spelling (Inspect where DevTools is on) | The shell refuses the menu only in the dashboard's own document, which draws its own; the runtime trims it everywhere else. |
| Eos › Rebuild & Relaunch (a build from a checkout) | Rebuilt the checkout and relaunched | Not in the menu | `eos build` does the same from the checkout. |
| The View menu | Reload, Toggle Developer Tools | Also Enter Full Screen (⌃⌘F) | The system's item; ⌃⌘F is not one of the dashboard's keys. |
| View › Reload | Emptied the HTTP cache first | Reloads | The dashboard is served from the bundle inside the app; there is no stale cache to empty. |

### Agents

| What | 0.1.x | Rust | Why |
|---|---|---|---|
| What runs an agent | The Claude Code program (`claude`), driven over its SDK | Eos's own engine (`eos-agent-sdk`) inside the app | Owner's decision D5. Most rows below follow from it. |
| A turn that fails (network, overload, a plan limit) | Ended as a finished turn (`turn: ended`) after an "API Error …" message | Ends as a failed turn (`turn: error`, reason `error_during_execution`) after a message saying why | The engine knows the turn failed; Claude Code only had a text. The dashboard shows both; a failed turn is marked as such. |
| A turn of an agent with no credential at all (not signed in, no key) | Claude Code's own "Not logged in · Please run /login" as the agent's answer; the turn ended | "Not signed in · Sign in to Claude under Settings › Accounts" as the agent's answer; the turn ended | The same form; it names where Eos signs in, since Eos has no `/login`. |
| A plan limit when every sign-in is out | The `accounts_exhausted` row and a finished turn | The same row and banner; the turn ends as failed, with no text of its own | As above. The row already says what happened. |
| The composer's `/` menu for a folder | The skills the `claude` program ships | The engine's own bundled skills; a name found twice is the one the engine's order picks | That is what a session there actually runs. |
| Other model providers | Codex (ChatGPT), Gemini and pay-per-token presets each had a lane | Claude only. "Sign in with ChatGPT" is offered on every build (the engine has its own ChatGPT sign-in); there is no Google sign-in | Owner's decisions D3 and D4: Gemini and the presets later. |
| Rewinding a chat | Restored the conversation and Claude Code's file checkpoints | Restores the conversation only | The engine keeps no file checkpoints. |
| A file edit (Edit, Write, NotebookEdit) outside the chat's folder | Left to the `claude` program's own rules for its working directories | Decided by Eos's policy like any call, with the path absolute: under Accept edits it is not accepted on its own but goes to the policy's rules and default (asks by default; the permission card says "outside this chat's folder"); Full access allows it. A `policy.yaml` rule or an "Always allow" for the tool decides it as for any path. Whatever the mode, no file tool writes the engine's folder or the data folder's state (`state.db*`, `accounts`, `secrets`, `browser`, `peer`, `sync`, `remote`, `updates`, `backups`, `conversations`) | One permission path for every write, and agents cannot change Eos's own state or sign-ins. A rule that matched a relative `file_path` (`^src/`) now sees an absolute one. |
| Stopping one subagent | Not possible from the window: interrupting stopped the whole turn | A running background subagent has a Stop control in the Subagents panel and its detail (`POST /workers/:id/subagents/:callId/stop`). It ends as Stopped with its own commands, its parent is told the user stopped it (an idle parent takes a turn on that), its own subagents carry on and report to the chat, and a later message to it is refused | The owner asked for it. |
| A subagent's declared permission mode (its definition's `permissionMode`, the Agent call's `mode`) | Applied by the `claude` program with its own modes; what it asked went to Eos's policy | Resolved by the engine's rule (`resolve_chain`: a call's mode only narrows; a definition's counts only under a subagent in `default`/`dontAsk`; `bypassPermissions` only under Full access) and decided by Eos's policy in that mode, never wider than the worker's: `plan` looks only (every changing call is denied, above the user's rules), `dontAsk` denies what would be asked, `default` asks for file edits too, `auto` is Accept edits. Right under a worker a definition's mode never counts, since both of Eos's modes are fixed ones in that rule (`eos-engine` `gate.rs`) | Eos has two modes; the engine's others exist only for subagents, and a subagent must never get more than its worker. |
| Skills in a subfolder's `.claude/skills` and skills with `paths` | Found by the `claude` program as it went | Found as agents read or write files below the chat's folder (git-ignored folders skipped); the model is told in a system reminder, which never shows in the chat. A name already taken is listed as `dir:name` (`apps/web:deploy`). The composer's `/` menu lists them once the session found them (`GET /commands?workerId=`, read again when the worker's state changes), and typing the prefixed name runs it | What the engine does; the menu shows what the session can run. |
| Goal loops (an orchestrator gives a worker a goal; at each idle edge a check of its criteria sends the worker back to work until they pass) | Present, off unless `config.loop.enabled` | None. `POST /orchestrators/:id/loop` and `…/loop/stop` are not served (404). A spawn that asks for a `loop` is refused before anything starts (400, "goal loops are not available — spawn the worker without `loop`"). A worker row never carries `loop`; a worker's report goes to its parent at once; `get_worker` answers `loop: null`. The prompt list and an exported chat page have no loop parts. The loop rows and the `loop` section of `config.json` a TypeScript app left are kept as they are and never read: such a worker works as a plain one | Owner's decision: the feature is to be designed again from scratch. |

### Accounts

| What | 0.1.x | Rust | Why |
|---|---|---|---|
| A ChatGPT sign-in made in the TypeScript app | Kept by the Codex CLI in `accounts/codex` (`CODEX_HOME`) | Not carried over. Settings › Accounts shows ChatGPT as "Sign-in expired · Sign in again" until the user signs in here (the engine's own sign-in, in `accounts/chatgpt`) or signs out. `accounts/codex` is never read for a token, renewed or changed | Its tokens belong to the Codex CLI's own client and lack the permission to use the plan that the engine's sign-in asks for, and renewing them here would spend the single-use refresh token the TypeScript app still holds. Each app renews only its own ChatGPT store, so going back and forth breaks neither. |
| A copied or moved data folder | `accounts/logins.json` names each sign-in's store by its absolute path, so a copy used the original folder's stores and keychain items (and could renew or sign them out) | A recorded store outside this data folder's `accounts` folder is read as the store of the same name inside it; the file is left as it is, and on the user's own folder nothing changes | A copy must never act with, renew or sign out the original's sign-ins. |
| A turn carried on after its session moved to another sign-in or the API key (a plan limit mid-turn, "Use API key", "Resume at") | Sent a hidden prompt, `accounts/continue` ("Your last reply was cut off by a plan usage limit … Continue the task from exactly where you stopped …"), as a hidden message to the agent | Sends the cut-off request again with no new input: nothing of Eos's enters the conversation. Settings › Prompts no longer lists `accounts/continue`; an override of it a 0.1.x app left in `prompts/accounts/continue.prompt.md` is listed there as the user's own prompt and never sent | Owner's decision: no extra prompt enters a chat when an agent carries on. |

### Chats

| What | 0.1.x | Rust | Why |
|---|---|---|---|
| Exporting a chat whose name has a character beyond Latin-1 (Turkish ş, ğ, ı; Chinese; emoji) | Failed (500): Node refuses such a download header | Exports. The name travels as the web standard says: the real name UTF-8 encoded, plus a plain-ASCII stand-in. Until the dashboard reads the real name (`docs/ui-patches/export-filename.md`) the file is saved under the stand-in | The owner's own chat names hit it. |
| An export whose file cannot be written in Downloads | Nothing was said (a line in Electron's log) | "Export failed" through the dashboard's error path (the console, and a banner while Eos is in the background) | A user who exported something must hear that it is not there. |
| `/clear` while the agent works | Swapped in a fresh session at once; the superseded query stopped without a word | Also at once: the running turn is interrupted and the conversation starts fresh. The interrupted turn records its `turn: aborted` row | The engine records every turn's end; nothing waits behind the turn, as in 0.1.x. |
| The rewind list | Only messages the user wrote | Also the notices delivered to the agent as a message of their own (a background task that finished, a teammate's message) | Owner's choice: a rewind can land right before such a notice. |
| After a compaction, what the next request starts with | The session context (CLAUDE.md), then the summary, then the message | The summary, then the session context with the message | The summary replaces the conversation in the engine and is saved at once; the session context opens the next message as on any turn. |
| `GET /pending?parentId=…` (the questions waiting in a session's children) | 500 whenever anything was waiting | Answers the list | 0.1.x's filter read a field name the rows do not have. |
| A message for a chat whose session is coming back (the composer wakes a chat at rest when the user starts typing) | Waited for the start, however long it took | Waits as 0.1.x does, in the order the messages came, for at most 30 s; then 502 `unreachable: worker` | A start that hangs must not hold a request, and every message behind it, forever. |
| A chat at rest woken with nothing sent (typing in the composer, an explicit resume) | SUSPENDED/DONE → SPAWNING (`resume`, the turn clock stamped) → IDLE (`resume_ready`), within the instant its start call took (the Claude Code process came up after it), so no client showed it working | Stays SUSPENDED/DONE while the session comes up, then goes straight to IDLE (`resume_ready`), the turn clock untouched. A message accepted during the start moves it to SPAWNING (`resume`) at once; it goes on to WORKING and ends the turn once | Here the start takes as long as the session takes to come up, so SPAWNING showed the chat working for that long. A start with no input is no turn: nothing (the dashboard, the phone, a paired Mac, the transcript's turn folds) may show it as one. No new state; only a resume takes the at-rest → IDLE move. |
| How much of a chat is kept | The newest 20,000 rows of its log (`events.maxPerWorker`); older messages were deleted, mid-turn | Everything. `events.maxPerWorker` still bounds a log when the user sets it; its default is 0, no bound | Owner's choice: a long chat lost its first days, and its transcript began in the middle of a turn. |
| A message that cannot reach its agent | 502; the chat kept nothing of it and the composer dropped its bubble without a word | 502 as in 0.1.x; the chat keeps the message with the "message was not delivered" line under it, and the composer shows any refused send with that line | The message is saved before it is sent, so the agent's answer never lands above it; a message that vanished silently was a defect the end-to-end audit found. |

### The phone

| What | 0.1.x | Rust | Why |
|---|---|---|---|
| A row patch (`state:patch`) while another worker's row cannot be read | Every changed worker went out as a remove: the list read behind it failed (500) on the unreadable row | Only the changed workers' rows are read, so a healthy changed row goes out as an upsert; an unreadable changed row, or a caller the list route refuses, still goes out as a remove | The patches read the changed rows by id instead of the whole list about seven times a second; matching the old answer would mean reading every row again. Only a damaged database row reaches it. |
| The phone's audit log (`remote/remote-audit.log`, one line per request, so one per keystroke in a terminal) | Grew without end | Same lines; at 8 MiB (about 40,000 requests) it becomes `remote-audit.log.1`, replacing the one before | It filled the disk over months. |
| The app's own logs, and `eos logs` | The daemon wrote `~/.eos/logs/daemon.log` (JSON lines, never rotated) and a log per agent (`o-*.log`, `w-*.log`) beside it; `eos logs [id]` tailed them | `core.log` and `shell.log` in `~/Library/Application Support/com.ibrahimalbyrk.eos/logs/` (text lines; rotated by size, at most about 19 MiB together), no log per agent (a session's lifecycle is in `core.log` by its id, its conversation in the database); `eos logs` prints the folder and the last lines of both, `eos logs --path` the folder; Help › Reveal Logs opens it | `~/.eos` is synced, backed up and copied for test runs, which logs have no place in; the 0.1.x files stay where they were, untouched. No message, prompt or file text is logged any more. |

### Browser panel

| What | 0.1.x | Rust | Why |
|---|---|---|---|
| Where tabs run | A second lane could start Chrome | The app's own embedded views only | The window is the browser now. |
| Without a window (a test, a replay) | Named the Chrome it would start | Says the browser is absent | There is nothing to start. |
| Whether a tab is playing sound | Known | Always "not playing" | The embedded browser (CEF) offers no way to ask. |
| Sites signed in to in the panel | Kept in Electron's profile | A new profile: those sign-ins are not carried over | The new browser cannot read the old one's cookie store. |

### Git panels and a worker's folder

| What | 0.1.x | Rust | Why |
|---|---|---|---|
| Which `git` is started | `git` on `PATH`: on a Mac usually `/usr/bin/git`, Apple's `xcrun` shim, which then starts the real one | The real binary behind it, found once from `git --exec-path` (looked up again if it moves); `git` on `PATH` when it cannot be found | The shim roughly doubled the cost of every command. Same binary, same settings. |
| What a git read may write | `git status` refreshed the index and wrote it back (taking `index.lock`) | Every read runs with `--no-optional-locks` and never writes | A read racing an agent's `git commit` made the commit fail on `index.lock`. |
| When the git routes ask git (diff, push-state, conflicts, changes, `/fs/branches`, `/fs/changes`) | On every request: a chat switch started 15 processes and walked the working tree four times | From what is kept per working tree. A tree the dashboard or a running worker watches is read again after the watcher, a git command Eos ran, a file Eos wrote or an agent's tool call says it changed, and at least every 30 s; reads of a tree nobody watches share one reading for a second | A warm chat switch takes well under a millisecond instead of 100–500 ms. A change made outside Eos to a tree nobody watches can take up to a second to show; a change no event reports (the global git config) up to 30 s. |
| How branches, the upstream, ahead/behind, remotes and the stash count are read | Nine git commands | In process (gix), by git's own naming rules; a repository gix might read differently (reftable, a configured branch order, URL rewriting, shallow history, replaced objects, a name two refs could claim, git settings from the environment, an untrusted folder) is still asked of git | The answers are the same: random runs of git operations compare every read with git's own after each step. |

### Visual answers

| What | 0.1.x | Rust | Why |
|---|---|---|---|
| Filtering text in a view | Lower-cases with the computer's language rules (a Turkish Mac turns `I` into `ı`) | Lower-cases without language rules | A view filters the same way on every Mac. |
| A view nested thousands of levels deep | The checker ran out of stack | Refused with a list of problems | A hostile view cannot crash the app. |

## Part 2: kept as in 0.1.x although it looks wrong

Each of these was copied on purpose. Changing one is the owner's decision.

| What happens | Why it looks wrong | Why it was kept |
|---|---|---|
| The report reminder never fires | A worker that goes idle without ever reporting to its parent is meant to get one reminder to report; in practice it never gets it | Turning it on changes what agents are told mid-task. That needs a decision, not a port. |
| "Dream now" starts a dream even while dreaming is switched off | The switch reads as "never dream" | 0.1.x's button does the same; the switch may be meant for the schedule only. |
| A sync record bigger than the relay's 8 MiB limit stops every domain after it from syncing | One very large page or memory blocks pages, templates and the rest behind it | Skipping or reordering records changes what other Macs see. That needs a decision. |
| The first "always allow" the user saves replaces the bundled hard denies | A click meant to allow one tool removes protections the app ships with | It is 0.1.x's rule, and changing it changes what agents may do. |
| Remote access (the phone) and hosting for paired Macs are on by default | Both let other devices reach this computer | 0.1.x's defaults (the owner turned remote on by default in commit c6a1d2e8). A test, a replay or a copy of someone's data never connects, whatever the setting. |
