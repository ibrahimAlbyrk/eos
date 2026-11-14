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
| Closing the window | The daemon kept running in the background, with a tray icon | The app stays in the Dock; quitting stops everything, agents included | Owner's decision D8; no tray. So the phone link and the nightly dream work only while the app runs. |
| Windows | Supported | Not yet; Windows stays on the last TypeScript release | Owner's decision D2. |

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
| Goal loops (an orchestrator gives a worker a goal; at each idle edge a check of its criteria sends the worker back to work until they pass) | Present, off unless `config.loop.enabled` | None. `POST /orchestrators/:id/loop` and `…/loop/stop` are not served (404). A spawn that asks for a `loop` is refused before anything starts (400, "goal loops are not available — spawn the worker without `loop`"). A worker row never carries `loop`; a worker's report goes to its parent at once; `get_worker` answers `loop: null`. The prompt list and an exported chat page have no loop parts. The loop rows and the `loop` section of `config.json` a TypeScript app left are kept as they are and never read: such a worker works as a plain one | Owner's decision: the feature is to be designed again from scratch. |

### Accounts

| What | 0.1.x | Rust | Why |
|---|---|---|---|
| A ChatGPT sign-in made in the TypeScript app | Kept by the Codex CLI in `accounts/codex` (`CODEX_HOME`) | Not carried over. Settings › Accounts shows ChatGPT as "Sign-in expired · Sign in again" until the user signs in here (the engine's own sign-in, in `accounts/chatgpt`) or signs out. `accounts/codex` is never read for a token, renewed or changed | Its tokens belong to the Codex CLI's own client and lack the permission to use the plan that the engine's sign-in asks for, and renewing them here would spend the single-use refresh token the TypeScript app still holds. Each app renews only its own ChatGPT store, so going back and forth breaks neither. |
| A copied or moved data folder | `accounts/logins.json` names each sign-in's store by its absolute path, so a copy used the original folder's stores and keychain items (and could renew or sign them out) | A recorded store outside this data folder's `accounts` folder is read as the store of the same name inside it; the file is left as it is, and on the user's own folder nothing changes | A copy must never act with, renew or sign out the original's sign-ins. |

### Chats

| What | 0.1.x | Rust | Why |
|---|---|---|---|
| Exporting a chat whose name has a character beyond Latin-1 (Turkish ş, ğ, ı; Chinese; emoji) | Failed (500): Node refuses such a download header | Exports. The name travels as the web standard says: the real name UTF-8 encoded, plus a plain-ASCII stand-in. Until the dashboard reads the real name (`docs/ui-patches/export-filename.md`) the file is saved under the stand-in | The owner's own chat names hit it. |
| An export whose file cannot be written in Downloads | Nothing was said (a line in Electron's log) | "Export failed" through the dashboard's error path (the console, and a banner while Eos is in the background) | A user who exported something must hear that it is not there. |
| The rewind list | Only messages the user wrote | Also the notices delivered to the agent as a message of their own (a background task that finished, a teammate's message) | Owner's choice: a rewind can land right before such a notice. |
| After a compaction, what the next request starts with | The session context (CLAUDE.md), then the summary, then the message | The summary, then the session context with the message | The summary replaces the conversation in the engine and is saved at once; the session context opens the next message as on any turn. |
| `GET /pending?parentId=…` (the questions waiting in a session's children) | 500 whenever anything was waiting | Answers the list | 0.1.x's filter read a field name the rows do not have. |
| A message for a chat whose session is coming back (the composer wakes a chat at rest when the user starts typing) | Waited for the start, however long it took | Waits as 0.1.x does, in the order the messages came, for at most 30 s; then 502 `unreachable: worker` | A start that hangs must not hold a request, and every message behind it, forever. |
| A message that cannot reach its agent | 502; the chat kept nothing of it and the composer dropped its bubble without a word | 502 as in 0.1.x; the chat keeps the message with the "message was not delivered" line under it, and the composer shows any refused send with that line | The message is saved before it is sent, so the agent's answer never lands above it; a message that vanished silently was a defect the end-to-end audit found. |

### The phone

| What | 0.1.x | Rust | Why |
|---|---|---|---|
| The phone's audit log (`remote/remote-audit.log`, one line per request, so one per keystroke in a terminal) | Grew without end | Same lines; at 8 MiB (about 40,000 requests) it becomes `remote-audit.log.1`, replacing the one before | It filled the disk over months. |

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
