# 03 — Native Message Rendering Map (Mac dashboard → SwiftUI, 1:1)

**Status:** Design spec only. No code ships from this document as-is; it is written to be copy-implementable and to serve as the **Phase 4 implementation backlog**.
**Scope:** Re-implement the Eos Mac dashboard's message/transcript subsystem (`app/ui/src/views/code/messages/*` + `app/ui/src/lib/messageParser.js`) as **native SwiftUI** in `ios/`. The owner chose a full native port — **not** a WKWebView of `app/ui`. Every message block and every tool card the Mac renders gets a planned SwiftUI view here.
**Reconciles with:** `02-ios-design-system.md` (the "warm paper + serif" design system: `EosColor`, `EosFont`, `EosSpacing`, `EosRadius`). §3.7 of that doc sketches `MessageView` at a high level and explicitly defers the deep tool/diff rendering to *this* spec.
**Source of truth (read-only):** the Mac React components listed above. The Swift side mirrors their **structure and behavior**; it re-skins their **visuals** onto the paper/serif aesthetic (§0.3).

---

## 0. Orientation

### 0.1 What the Mac subsystem actually is

Two moving parts:

1. **`lib/messageParser.js`** — a pure event→block pipeline. Takes the durable event rows for one agent and produces an ordered array of ~22 **block kinds**. It does: `applyClears`/`applyRewinds`/`applyRecalls` (display-only history edits) → `normalizeEvents` (canonical `agent_event` rows → legacy content shapes) → `deriveToolLifecycle` (is-a-tool-running) → agent-span attribution (subagent inner-tool folding) → **grouping by lane** (consecutive same-lane tools collapse into a `toolGroup`) → block list, sorted by creation-domain `ts`.
2. **`views/code/messages/*`** — the render layer. `Messages.jsx`'s `renderBlock` switch dispatches each block kind to a component; `ToolItem.jsx` + `toolViews.jsx` are a second dispatcher that maps ~40 tool names to a header-label descriptor + an expandable **Detail** body.

Live streaming (thinking deltas, terminal chunks, goal-check progress) lives in **module stores** outside the event pipeline and is **overlaid** onto the durable blocks at render time (`Messages.jsx` second `useMemo`), then dropped by `blockId`/`runId` when the durable row lands.

### 0.2 What already exists on the Swift side (extend, don't replace)

| Swift file | What it is | Verdict |
|---|---|---|
| `EosRemoteKit/Models/Domain.swift` → `Block` | A normalized block: `{ id, workerId, blockId, kind: Kind, ts, text, raw }`. `Kind` enum already lists `user, assistant, thinking, tool, toolGroup, agentRun, report, directive, peerRequest, loop, terminal, deliveryFailed, cleared, push, pull, worktreePreserved, hook, exit, jsonl, unknown`. | **Extend.** The kind set is ~right; the block is too thin (only carries `text`) — it must carry typed per-kind payloads (see §4.2). |
| `EosRemoteKit/Data/MessageNormalizer.swift` | Port of `normalizeEvents` — collapses both event taxonomies to `[Block]`, one row → several blocks, drops non-conversational rows. **Currently lossy:** `tool_use` becomes `Block(.tool, text: name)` with no input/result; `tool_result` is dropped entirely; no lifecycle, no grouping, no agent spans. | **Rewrite as a two-stage pipeline** (§4). Keep the row→content-block expansion; add lifecycle + attribution + grouping + tool-result folding on top. |
| `EosRemoteKit/Data/StreamingBuffers.swift` | `ThinkingBuffers` (live text/reasoning by `blockId`), `TerminalBuffers` (live terminal by `runId`), `EventsWindow` (id-keyed merge, `(ts,id)` sort), `Outbox`. | **Keep.** These are the live-overlay stores. Add a `LoopCheckBuffer` (§4.5) for goal-check progress. |
| `EosRemote/Views/BlockView.swift` | Crude label renderer: bubbles for user/assistant, `Label(icon,text,color)` for everything else. Carries a "future WKWebView escape hatch" comment. | **Replace** with the `MessageView` dispatcher + the per-kind/per-tool views in this spec. |
| `EosRemote/Views/WorkerDetailView.swift` | `ScrollView`+`LazyVStack(BlockView)`, `.defaultScrollAnchor(.bottom)`, composer. | **Keep the shell.** `02` §3.5 restyles it; swap `BlockView` → `MessageView`. |

**Net:** the Swift block *model* and the *live stores* are the right skeleton but under-built. This spec extends the model to carry typed payloads and rebuilds the normalizer into the full parser. The renderer is new.

### 0.3 Visual reconciliation with `02` (the paper/serif shift)

The Mac styling is a **dark, dense, technical** IDE transcript (`--surface #1f1f1f`, sans `--font-ui`, mono `JetBrains Mono`, tight rhythm). `02` re-skins the app to **warm paper + serif**. The port keeps the Mac's **information architecture and layout** (which verb, which file chip, which badge, which diff stat, what expands) but recolors and re-types:

| Mac token | Role | Paper-theme mapping (`02` §1.2) |
|---|---|---|
| `--fg #ebebeb` | primary text | `EosColor.ink` |
| `--fg-dim #8a8a8a` | tool verbs, secondary | `EosColor.inkSecondary` |
| `--fg-faint #5a5a5a` | arg hints, timestamps, list markers | `EosColor.inkTertiary` |
| `--surface #1f1f1f` | tool-group / pre / terminal fill | `EosColor.surface` |
| `--surface-2 #252525` | inline code, chip fills | `EosColor.bgSunken` / `surfaceHi` |
| `--border #262626` | card borders | `EosColor.hairline` |
| `--accent #6ea4e8` | links, agent refs, spark | `EosColor.coral` |
| `--ok #67c084` | success (git, met, exit ✓) | `EosColor.State.runningDot` |
| `--warn #d4a55a` | warn (group dot, stopped, denied) | `EosColor.State.waitingDot` |
| `--err #d97670` | failures, unmet, exit ✗ | `EosColor.State.failedDot` |
| `--font-ui` (sans) | **assistant prose** | **New York serif** `EosFont.bodySerif` + `.lineSpacing(4)` — the deliberate aesthetic change (`02` §3.7) |
| `--font-mono` (JetBrains) | code, diffs, terminal, thinking, ids | `EosFont.mono` — **see §5.4 decision** (SF Mono default vs. bundled JetBrains Mono) |

Two rules for the whole port:
- **Prose renders in serif; everything technical renders in mono.** Tool headers, file chips, and card labels are UI text → `EosFont.label`/`caption` (SF). Code/diff/terminal/thinking/id bodies → `EosFont.mono`.
- **State color is reserved for run-state.** Just as the Mac keeps `--ok/--warn/--err` for lifecycle only, the paper port uses `EosColor.State.*` only for running/failed/met/denied — never as a decorative kind accent.

---

## 1. The complete block-kind map (`Messages.jsx` `renderBlock`)

Every case in `renderBlock` (Messages.jsx L555–624) → a planned SwiftUI view. `MessageView(block:)` is the dispatcher (replaces `BlockView`). Blocks in `MESSAGE_ROW_KINDS` (`user, report, directive, peerRequest, loop, assistant`) are wrapped in `MessageRowView` (§5.2) which supplies the hover/tap action row.

| # | Block `kind` | Mac component | Planned SwiftUI view | Shape it renders (from parser) | Visual structure | Tier |
|---|---|---|---|---|---|---|
| 1 | `user` | `MessageUser` in `MessageRow` | `UserMessageView` in `MessageRowView` | `{ text, ts, optimistic? }` | Right-aligned wash bubble (`coralWash`, r=`card`, `EosFont.body`). Body runs the **rich-text segmenter** (§5.5): URLs→coral links, attachment labels→chip, paste-pill, slash-pill, `@`-shortened cwd paths. Attachments (images/files/folders) render as a chip row above the bubble. Action row: copy + **rewind** (if backend supports) + timestamp. | 1 |
| 2 | `assistant` | `MessageAssistant` in `MessageRow` | `AssistantMessageView` in `MessageRowView` | `{ text, ts, blockId? }` | Full-width **serif Markdown prose** (§5.1). Blur-in reveal on arrival (§6.1). Code fences → mono card w/ copy button + syntax highlight (§5.4). Mermaid → §5.6. Action row: copy + timestamp. | 1 |
| 3 | `thinking` | `ThinkingLine` | `ThinkingLineView` | `{ text, ts, blockId?, live? }` | No bubble, no label. Raw reasoning text in **mono**, `inkTertiary`, `line-height 1.55`. Streams token-by-token with blur-in on the appended tail (§6.1). NOT wrapped in a MessageRow. | 1 |
| 4 | `toolGroup` | `ToolGroup` | `ToolGroupView` | `{ lane, summary, tools[], ts }` | Disclosure header: summary string (`"Read 3 files, Edited 2 files, ran 1 shell command"`), `inkSecondary`, chevron. Expanded → bordered card (`surface`, r=10) listing `ToolItemView`s. Default-open resolved from settings (§6.3). | 1 |
| 5 | `tool` | `ToolItem standalone` | `ToolItemView(standalone:)` | `{ tool }` (one tool obj) | The universal tool row — see §2 (the ~40-entry registry). Header verb + file/agent-ref + arg-summary + badge + diff-stats + failure badge; expandable Detail body. | 1 |
| 6 | `agentRun` | `AgentBlock` (+ `AgentViewer` panel) | `AgentBlockView` (+ `AgentViewerSheet`) | `{ toolUseId, description, prompt, model, subagentType, status, background, result, tools[], ts }` | Sub-agent (`Agent`/`spawnsSubagent`) run. Done+result → one-line "Ran agent {model} {desc}" (tap opens viewer). Running/no-result → header ("Running agent"/"Background agent started") + a card (title shimmer, "· N tools", chevron) → tap opens `AgentViewerSheet` (prompt bubble + inner `ToolItemView`s + serif result). | 1 |
| 7 | `report` | `MessageReport` (dir=in) in `MessageRow` | `MessageReportView(direction: .in)` in row | `{ text, fromWorker, workerName, ts }` | Collapsible `tool-item`-style row: "Report from **{AgentLink}**" + chevron; expanded → plain-text body (`report-detail`). If `workerName == "workflow"` → `WorkflowReportView` (§3) instead. | 1 |
| 8 | `directive` | `MessageReport` (dir=out) in `MessageRow` | `MessageReportView(direction: .out)` in row | `{ text, fromParent, parentName, ts }` | Same chrome as report; label "Message from **{AgentLink}**". | 1 |
| 9 | `peer-request` | `MessageReport` (label) in `MessageRow` | `MessageReportView(label:)` in row | `{ text, fromWorker, fromName, ts }` | Same chrome; label "Peer request from **{AgentLink}**". | 2 |
| 10 | `loop` | `MessageLoop` in `MessageRow` | `MessageLoopView` in row | `{ text, ts }` | Collapsible system row (NOT a user bubble): "Dynamic loop — automated goal-check" + chevron; expanded → the re-trigger text. | 2 |
| 11 | `loopCheck` | `LoopCheckBlock` | `LoopCheckLineView` | `{ attempt, maxAttempts, strategy, met, outcome, reason, ts }` | Thin inline marker (like git lines): icon (`✓` met / `!` escalated / `·` unmet) + "Goal check · attempt N/M · {outcome}" + reason. Colored ok/unmet/escalated. Mono. | 2 |
| 12 | `terminal` | `TerminalCard` | `TerminalCardView` | `{ runId, command, output, exitCode, note, truncated, done, live? }` | Mono card. Head: `❯` + command + (running: spinner + stop button / done: `✓` or `✗ {code}`). Output block (auto-tail while live). Note/truncated footer. Blur-in entrance on fresh (§6.1). | 2 |
| 13 | `deliveryFailed` | inline div | `SystemLineView(.deliveryFailed)` | `{ text, ts }` | Mono line, `failed` tint: "message was not delivered — "{text}" · try sending again". | 3 |
| 14 | `cleared` | inline div | `SystemLineView(.cleared)` | `{ ts }` | Mono centered divider: "conversation cleared". | 3 |
| 15 | `turnError` | inline div | `SystemLineView(.turnError)` | `{ reason, message, ts }` | Mono line, `failed` tint: `!` icon + humanized provider-error message (§4.6). | 3 |
| 16 | `push` | inline div | `GitLineView(.push)` | `{ outcome, ok, message, branch, ts }` | Mono line: `↑` (ok) / `!` (err) + message + branch chip. ok→`running` tint, err→`failed`. | 3 |
| 17 | `pull` | inline div | `GitLineView(.pull)` | `{ outcome, ok, message, branch, ts }` | Same as push with `↓`. | 3 |
| 18 | `worktreePreserved` | inline div | `WorktreePreservedView` | `{ path, branch, diffStat, ts }` | Mono card: "Worktree preserved" + "{branch} · N files changed · {path}" + **Reveal** button (calls `revealFile` — on iOS: no-op/copy-path, see §7). | 3 |
| — | *(top-of-transcript)* `MessageTask` | `MessageTask` | `TaskFromView` | worker `{ prompt, parentId, parentName }` (not a block; rendered above the list when `worker.parent_id`) | Accent-tinted card: task icon + "Task from **{AgentLink}**" + prompt body (verbatim plain text, URL-linkified only). | 2 |
| — | *(top-of-transcript)* `LoopStatus` | `LoopStatus` | `LoopStatusCardView` | `worker.loop` + `history` (loopCheck blocks) | Status card at transcript top: dot + "Loop · {status}" + "attempt N/M" + goal summary + last reason + last-5 attempt history rows. Colored by `st-active/passed/exhausted/stopped`. | 2 |
| — | *(foot)* `ProcessingLine` | `ProcessingLine` | `ProcessingLineView` | `{ busy, elapsed }` | Activity anchor under the latest reply: animated 4-point spark + live elapsed when busy; static spark when idle. | 1 |
| — | *(foot)* `GoalCheckLine` | `GoalCheckLine` | `GoalCheckLineView` | live `LoopCheckProgress` (transient) | Shown in the ProcessingLine region while a looped worker's goal check runs on idle: spark + "Goal check · attempt N/M · {phase}" + M:SS. | 2 |

**Not ported (Mac-only surfaces, out of scope):** `FindBar` (⌘F page-find; iOS uses native find-in-scrollview or is dropped — §5.7), and the file/diff/commits **viewers** (`FileViewer`, `DiffViewer`, `EditView`, `CommitsViewer`, `SymbolRefsPanel`) which are side-panel tools opened from file chips, not transcript blocks. On iOS a file-chip tap opens a lightweight `FileViewerSheet` (deferred; not part of the transcript backlog).

---

## 2. The complete tool-detail map (`toolViews.jsx` registry, ~40 entries)

`ToolItem.jsx` is the single tool chrome. It reads a **descriptor** from `getToolView(tool.name)` (the `VIEWS` registry in `toolViews.jsx`) with these fields — the Swift port models the same descriptor:

```
protocol ToolView {
  func label(_ t: Tool) -> (verb: String, file: String)         // collapsed, done
  func runningLabel(_ t: Tool) -> (verb: String, file: String)  // collapsed, running
  func summary(_ t: Tool) -> String?      // extra dim args hint after the file
  func filePath(_ t: Tool) -> String?     // makes `file` a tappable file chip
  func agentRef(_ t: Tool, _ ctx) -> AgentRef?   // makes `file` a tappable AgentLink
  func headerBadge(_ t: Tool, _ ctx) -> HeaderBadge?  // right-edge pill (loop/status/task)
  func stats(_ t: Tool) -> DiffStat?      // +add / -del chip
  func expandable(_ t: Tool, _ ctx) -> Bool
  func detail(_ t: Tool, _ ctx) -> AnyView   // expanded body
}
```

The chrome (`ToolItemView`, §5.3): `[verb] [file-chip | AgentLink] [arg-summary] [headerBadge] [failure-badge] [+add -del]` as the disclosure header; `[Detail]` when expanded. `verb` shimmers while running (§6.4); a failed tool tints the whole row and shows a `denied`/`failed` badge.

`BASE` descriptor default: verb="Used", file=humanized tool name, `summary=nil`, `expandable=true`, detail=`GenericToolCardView`. `FALLBACK` = BASE + `summary = argsSummary(input)`. **Any tool not in the table below resolves to FALLBACK** → its row still says *what it acted on*, and its Detail is the generic parameters/output/raw-payload card.

Legend for **Detail body**: the SwiftUI view that renders the expanded content.

### 2.1 File & shell tools (Tier 1)

| Tool name | Label (done → running) | Header extras | Detail body | Detail structure |
|---|---|---|---|---|
| `Read` | "Read {basename}" → "Reading {basename}" (if the read is a SKILL.md, file="{skill} SKILL") | file chip (opens viewer) | `ReadDetailView` | File-path bar (path + copy button) → first 5 source lines w/ line numbers (`stripCatLineNumbers`), heading lines highlighted; "(N more lines)" fade; "Reading…" while running. |
| `Edit` | "Edit {basename}" → "Editing {basename}" | file chip; **diff stats** `+add/-del` (LCS of old/new) | `EditDetailView` | Failure banner (if error) → filepath → **diff hunks** (§5.8): prefer `result.patch` (absolute line #s) else LCS of `old_string`/`new_string` (relative). Each row: line# + `+`/`-`/` ` sign + text w/ inline word-level highlight. |
| `MultiEdit` | "Edit {basename}" → "Editing {basename}" | file chip; diff stats (sum of all edits) | `MultiEditDetailView` | Same as Edit; if `result.patch` present → one file-wide diff, else one diff block per edit in `edits[]`. |
| `Write` | "Write {basename}" → "Writing {basename}" | file chip | `WriteDetailView` | Failure banner → file-path bar (copy) → first 5 lines of `content` w/ line numbers; "(N more lines)". |
| `Bash` | git-aware: "Ran {cmd≤60}" OR git verbs ("Committed {sha}", "Pushed", "Viewed 2 diffs"…) → "Running {cmd≤60}" | — | `BashDetailView` | "Bash" label → `$` + command → output (≤4000 chars, "Running…"/"(no output)") → failure banner. Git verb detection = `gitActions()` regex over the command (§4.7). |
| `Glob` | (BASE "Used Glob") → "Searching {pattern}" | — | GenericToolCard | fallback |
| `Grep` | (BASE) → "Searching {pattern/query}" | — | GenericToolCard | fallback |

### 2.2 Web & user-interaction tools (Tier 1–2)

| Tool name | Label (done → running) | Header extras | Detail body | Detail structure |
|---|---|---|---|---|
| `WebSearch` | "Searched the web {query}" → "Searching the web {query}" | — | GenericToolCard | fallback |
| `WebFetch` | "Fetched {host}" → "Fetching {host}" | — | GenericToolCard | fallback |
| `AskUserQuestion` | "Asked user" → "Asking user" (**STANDALONE**, never grouped) | — | `AskUserQuestionDetailView` | Q→A list: each question + (answer `→ {a}` / "Waiting…"). Answers parsed from a following "My answers…"/"Your questions have been answered…" user message (§4.8, folded by `attachAskUserAnswers`). Tier 1. |
| `mcp__orchestrator__ask_user` | "Asked user" → "Asking user" | — | `AskUserDetailView` | Same Q→A chrome; answers from the tool's own JSON `{answers:{question:label}}`; a dismissed/stale result shows a plain sentence under the questions. Tier 2. |
| `mcp__orchestrator__notify_user` | "Notified user" → "Notifying user" (**STANDALONE**) | — | `NotifyDetailView` | Bell icon + `title`; `body` line beneath. Tier 2. |
| `Skill` | "Used {skill} skill" → "Using {skill} skill" (**STANDALONE**) | file chip (skill dir, from parsed body) | `SkillDetailView` | If injected SKILL.md body present → file-path bar (`~`-shortened) + copy + first 5 lines w/ line numbers; else fall back to GenericToolCard (sdk lane has no body). Tier 2. |

### 2.3 Worker-management tools (Tier 2) — lane = `worker` (group together)

All bodies via `WorkerToolBodyView` (`WorkerToolCard.jsx`). Verbs from `WORKER_TOOL_SPECS`. spawn/kill/message/get name their target via a tappable **AgentLink** (`agentRef`); list tools show a count.

| Tool name | Label (done → running) | Header extras | Detail body | Detail structure |
|---|---|---|---|---|
| `mcp__orchestrator__spawn_worker` | "Spawned {AgentLink}" → "Spawning" | AgentLink; **loop badge** if `input.loop` | `WorkerToolBodyView` | Optional loop-detail line ("Loop: {goal} · {strategy} · limit N") + the spawn `prompt` text. Expandable only if body non-empty. |
| `mcp__orchestrator__kill_worker` | "Killed {AgentLink}" → "Killing" | AgentLink | `WorkerToolBodyView` | "{state} · {branch}" from result JSON. |
| `mcp__orchestrator__message_worker` | "Messaged {AgentLink}" → "Messaging" | AgentLink | `WorkerToolBodyView` | the `text` sent. |
| `mcp__orchestrator__get_worker` | "Checked {AgentLink}" → "Checking" | AgentLink | `WorkerToolBodyView` | "{state} · {branch}" / "${cost} · N events" / clipped prompt. |
| `mcp__orchestrator__list_active_workers` | "Listed workers (N)" → "Listing workers" | count | `WorkerToolBodyView` | AgentLink rows: "{name} · {state}" + clipped prompt, one per worker (durable names from the result snapshot). |
| `mcp__orchestrator__list_pending_permissions` | "Checked pending permissions" → "Checking" | — | `WorkerToolBodyView` | Rows: "{worker name} · {tool}" + input summary. |
| `mcp__orchestrator__create_worker` | "Created worker {name}" → "Creating worker {name}" | — | `CreateWorkerDetailView` | Blueprint card: description → config chips (model/effort/mode/extends) + flags (persistent/collaborate) → "When to use" text → **Tools** (allow/deny globs as +/− pills, or "all tools") + `editRegex` line → **Instructions** body (first 12 lines + "(+N more)"). Renders from input while running. |
| `mcp__orchestrator__list_available_workers` | "Listed available workers (N)" → "Listing available workers" | count | `AvailableWorkersDetailView` | Rows: name + provenance badge (builtin/user/project/runtime) + whenToUse/description. "No available workers." empty. |

### 2.4 Peer tools (Tier 2) — lane = `worker`

| Tool name | Label (done → running) | Header extras | Detail body | Detail structure |
|---|---|---|---|---|
| `mcp__worker__ask_peer` | "Asked {peer}" → "Asking {peer}" | AgentLink (peer, via `peerTo` link or input) | `PeerAskDetailView` | Q→A: `question` + peer's answer (`→`) / "Waiting…". |
| `mcp__worker__respond_to_peer` | "Replied to {peer}" → "Replying to {peer}" | AgentLink (peer, via parser-linked `peerTo` or result JSON) | `PeerRespondDetailView` | the `answer` text (report-detail body). |
| `mcp__worker__list_peers` | "Listed peers" → "Listing peers" | — | `PeerListDetailView` | Rows: "{name} · {state}" + specialty summary. "No peers available." empty. |
| `mcp__worker__send_message_to_parent` | "Sent report to orchestrator" (**STANDALONE**) | AgentLink (parent, from ctx) | `MessageDetailView` | the report `text` (report-detail body). |

### 2.5 Task-management tools (Tier 2) — harness built-ins, lane = `generic`

Results are **plain text** (not JSON); parsed here.

| Tool name | Label (done → running) | Header extras | Detail body | Detail structure |
|---|---|---|---|---|
| `TaskCreate` | "Created task {subject}" → "Creating task {subject}" | status badge "pending" | `TaskCreateDetailView` | Card: subject heading + pending badge + description. |
| `TaskUpdate` | "Updated task #{id}" → "Updating task #{id}" | status badge (`input.status`) | `TaskUpdateDetailView` | Card: "Task #{id}" + new-status badge + changed description + subject/owner chips + added blocks/blockedBy dep pills. |
| `TaskGet` | "Read task #{id}" → "Reading task #{id}" | status badge (parsed) | `TaskGetDetailView` | Card: subject + status badge + description + dep pills (parsed from plain-text result). |
| `TaskList` | "Listed tasks (N)" → "Listing tasks" | count | `TaskListDetailView` | Table rows: "#{id}" + status badge + subject + owner + "blocked by" pill (parsed per line). |
| `TodoWrite` | "Updated task list" → "Updating tasks…" | summary "N items (X done, Y active, Z pending)" | `TodoWriteDetailView` | Card: header count line + one status-badge row per todo (`activeForm`/`content`). |

### 2.6 Other harness built-ins & workflow (Tier 2)

| Tool name | Label (done → running) | Header extras | Detail body | Detail structure |
|---|---|---|---|---|
| `mcp__orchestrator__workflow` | mode-aware: "Ran/Saved/Checked/Stopped workflow {name}" → "Running/Saving/…" | **status chip** (passed/failed/running/pending/stopped) | `WorkflowToolDetailView` | Card: run id + status chip → optional message → pretty-printed `output` (`<pre>`, copy button). §3. |
| `mcp__orchestrator__current_datetime` / `mcp__worker__current_datetime` | "Checked date & time" → "Checking date & time" | — | `DatetimeDetailView` | One line: clock icon + the result's `formatted` string. |
| `ToolSearch` | "Searched tools {query}" → "Searching tools {query}" | — | `ToolSearchDetailView` | "N tools matched" + matched tool-name chips (parsed from `<function>` blocks). |
| `ScheduleWakeup` | "Scheduled wakeup {delay}" → "Scheduling wakeup {delay}" | — | `ScheduleWakeupDetailView` | Card: reason heading + "in {delay}" chip + clamped wake prompt. Renders from input while running. |
| `TaskOutput` | "Read task output {id}" → "Reading task output {id}" | — | `TaskOutputDetailView` | Captured stdout (≤4000 chars + "+N more"). |

### 2.7 Fallback (unregistered tools) — Tier 1 (needed for every unknown MCP tool)

| Descriptor | Label | Detail body | Detail structure |
|---|---|---|---|
| `FALLBACK` | "Used {humanized name}" + `argsSummary(input)` hint → "Running {name}" | `GenericToolCardView` | One card: **Parameters** (key: value rows, scalars inline / objects as clamped JSON, copy) + **Output** (result text ≤4000 + "+N more", copy) + collapsed **Raw payload** disclosure (full `{input,result}` JSON ≤8000, copy). "Running…" if no output yet. Renders nothing if empty & not failed. |

> **Backlog completeness:** §2 lists **all ~40 registered tools** plus the fallback. The long tail (datetime, ToolSearch, ScheduleWakeup, TaskOutput, the five worker tools, three peer tools, five task tools, create/list workers, workflow) is Tier 2; only Read/Edit/MultiEdit/Write/Bash + GenericToolCard are Tier 1. Everything not registered is *already covered* by GenericToolCard, so shipping Tier 1 = every tool renders *something* correct; Tier 2 upgrades the named ones to their bespoke card.

---

## 3. Workflow surfaces (`WorkflowCard.jsx`)

Two entry points, both Tier 2:
- **`WorkflowToolDetailView`** — the `mcp__orchestrator__workflow` tool's Detail (registered in §2.6). Status chip + run id + message + pretty output.
- **`WorkflowReportView`** — a `report` block whose `workerName == "workflow"` renders here instead of `MessageReportView` (branch in the `report` case, Messages.jsx L558). Standalone `tool-item`: "Workflow completed" + run id + status chip (parsed from "[workflow {id}] completed (status: {s})") + collapsible pretty-printed result.

`WorkflowStatusChip`: passed→`running` green, failed→`failed` red, running→`coral`, stopped→`waiting` amber, pending→`inkTertiary` neutral. `prettyValue()` = indent JSON / reparse JSON-in-string / passthrough — port as a Swift helper.

---

## 4. The Swift event→block parser (mirror of `messageParser.js`)

Rebuild `MessageNormalizer` into a staged pipeline. Keep it in `EosRemoteKit` (pure, testable, zero SwiftUI). The existing `MessageNormalizerTests` + `NoiseFixtureTests` give a regression harness; port the JS `messageParser.test.js` fixtures alongside.

### 4.1 Pipeline stages (call order)

```
rows: [JSONValue]                          // durable event rows for one worker (EventsWindow.ordered)
  → applyClears(rows)                      // §4.3
  → applyRewinds(rows, bootPromptOffset)   // §4.3
  → applyRecalls(rows)                     // §4.3
  → buildBlocks(...)                        // §4.4  (== normalizeEvents ∘ decode)
      → normalizeEvents(rows) : [Ev]        // canonical agent_event → legacy content shapes
      → deriveToolLifecycle(evs)            // §4.6  running/done/closed
      → agent-span attribution              // §4.5  subagent inner-tool folding
      → main decode loop → [Block] w/ lane grouping (flushTools/pushTool)  // §4.4
      → attachAskUserAnswers([Block])       // §4.8
  → sortBlocksByTs(blocks)                  // §4.9  stable sort by creation-domain ts
```

Then, **at render time** (not in the pure pipeline), the live overlays merge (§4.10).

### 4.2 The extended `Block` model

The current `Block` only carries `text`. Replace with a `kind` + a **typed associated payload** (a Swift enum with cases mirroring the JS block shapes) so views read structured fields, not re-parsed strings. Keep `id`/`workerId`/`blockId`/`ts` on the envelope for identity, streaming handoff, and sort.

```swift
public struct Block: Identifiable, Sendable, Equatable {
    public let id: String            // stable render key (see §4.9 keying)
    public let workerId: String
    public let blockId: String?      // live→durable handoff (thinking/assistant)
    public let ts: Double            // creation-domain (tsTranscript/anchorTs), see §4.9
    public var live: Bool = false
    public let payload: Payload

    public enum Payload: Sendable, Equatable {
        case user(text: String, optimistic: Bool)
        case assistant(text: String)
        case thinking(text: String)
        case tool(Tool)                                  // §4.2.1
        case toolGroup(lane: Lane, summary: String, tools: [Tool])
        case agentRun(AgentRun)                          // §4.2.2
        case report(text: String, fromWorker: String?, workerName: String?)
        case directive(text: String, fromParent: String?, parentName: String?)
        case peerRequest(text: String, fromWorker: String?, fromName: String?)
        case loop(text: String)
        case loopCheck(LoopCheck)                        // §4.2.3
        case terminal(Terminal)                          // §4.2.4
        case deliveryFailed(text: String)
        case cleared
        case turnError(reason: String, message: String)
        case gitPush(ok: Bool, message: String, branch: String?)
        case gitPull(ok: Bool, message: String, branch: String?)
        case worktreePreserved(path: String, branch: String, diffStat: String)
    }
    public enum Lane: Sendable { case generic, worker }
}
```

#### 4.2.1 `Tool`

```swift
public struct Tool: Sendable, Equatable {
    public let id: String
    public let name: String
    public var verb: String                 // verbFor(name): "bash" | "edit" | "read"
    public let input: JSONValue
    public var result: ToolResult?          // { text, isError, patch? }
    public var running: Bool                 // authoritative (from lifecycle)
    public var done: Bool
    public let ts: Double
    public var skillBody: String?            // Skill only
    public var skillPath: String?
    public var peerTo: AgentRef?             // ask_peer/respond_to_peer link
}
public struct ToolResult: Sendable, Equatable { public let text: String; public let isError: Bool; public let patch: JSONValue? }
public struct AgentRef: Sendable, Equatable { public let id: String?; public let name: String? }
```

#### 4.2.2 `AgentRun` — `{ toolUseId, description, prompt, model, subagentType, status, background, result, tools:[Tool] }`.
#### 4.2.3 `LoopCheck` — `{ attempt, maxAttempts, strategy, met, outcome, reason }`.
#### 4.2.4 `Terminal` — `{ runId, command, output, exitCode, note, truncated, done }`.

### 4.3 Display-history edits (before build)

Port verbatim — these are display-only (the store keeps the rows):
- **`applyClears`** — find the last `conversation_cleared`; drop everything before it (keep the marker → renders `cleared` divider).
- **`applyRewinds`** — for each `conversation_rewound`, cut the abandoned branch: match by rewound text (either-way prefix, `normRewindText` = collapse whitespace) among `user_message`/`orchestrator_message`; fallback by `payload.index` position (with `bootPromptOffset` = 1 when an orchestrator-spawned worker's boot prompt has no event).
- **`applyRecalls`** — drop `user_message` rows whose id ∈ recalled `recalledRowId` or whose `clientMsgIds` intersect recalled `clientMsgId`s; the `message_recalled` marker itself renders nothing.

### 4.4 `normalizeEvents` + the decode loop

**`normalizeEvents`** (the current `MessageNormalizer` already does most of this) expands `agent_event` rows into the legacy `{type:"jsonl"/"tool_running"/"tool_done"/"hook"/"exit"/…}` shapes so one decoder handles both lanes:
- `message`(assistant) blocks → `jsonl` `assistant_text` / `thinking` / `tool_use`(+`spawnsSubagent`) / `tool_result` / `skill_body`.
- `message`(tool) → `jsonl` `tool_result`.
- `activity` → `tool_running` / `tool_done` (drop `alive` heartbeat).
- `turn`(≠started) → `hook{Stop}` barrier; `turn.phase=="error"` → also a `turn_error` block.
- `session`(ended) → `exit` barrier.
- `subagent_started`/`subagent_completed` → passthrough for span bounding.

**The decode loop** (buildBlocks main body) then walks the normalized stream and emits blocks. Key behaviors to preserve:
- **Text coalescing:** consecutive `assistant_text` blocks merge into one `assistant` block (`lastAsst.text += "\n" + t`) as long as it's still the last-pushed block.
- **Empty-thinking skip:** `thinking` with no non-whitespace text is dropped (signature-only blocks).
- Synthesized rows (`user_message`, `worker_report`, `orchestrator_message`, `loop_continuation`, `loop_check`, `peer_request`, `peer_consult`, `lifecycle{delivery_failed}`, `turn_error`, `conversation_cleared`, `terminal`, `git_push`, `git_pull`, `worktree{preserved}`) each flush pending tools and push their block.
- **`peer_consult`** is transparent (no block): it links the consulted peer's name back onto the pending `ask_peer` tool (`lastAskPeer.peerTo`). **`peer_request`** sets `lastPeerReq` so a following `respond_to_peer` (whose input has no asker) gets `tool.peerTo = lastPeerReq`.

**Lane grouping** (`pushTool`/`flushTools`):
- `laneOf(name)`: `STANDALONE_TOOLS` → `nil` (never groups: `Agent`, `AskUserQuestion`, `Skill`, `EnterPlanMode`, `ExitPlanMode`, `mcp__orchestrator__notify_user`, `mcp__worker__send_message_to_parent`); worker-tool → `worker`; else `generic`.
- A consecutive run of the same lane accumulates; a lane change or any non-tool row `flushTools()`. A flush of 1 tool → a `tool` block; >1 → a `toolGroup` with `summary = LANES[lane].summarize(tools)` (`buildSummary` for generic, `buildWorkerSummary` for worker).
- A `nil`-lane tool flushes first, then pushes its own standalone `tool` block.

### 4.5 Agent-span attribution (subagent inner-tool folding)

Port the `agentSpans` machinery so a subagent's inner tool calls fold **into** its `agentRun` block instead of appearing as loose transcript tools:
- A `tool_use` with `spawnsSubagent==true` or `name=="Agent"` opens a span `{startTs, endTs:∞, background:false}`.
- `subagent_started(callId)` marks the span **background**; `subagent_completed` bounds `endTs` and carries the true `status`+`result`. Foreground spans close on their `tool_result`.
- A `tool_running` event with no transcript `tool_use` (hook-only inner tool) is attributed to a span by `parentAgentToolUseId` (exact) else the nearest containing/most-recent span by `ts`. Attributed tool ids are excluded from the top-level stream.
- Background spans are **turn-exempt** in lifecycle (they outlive turns).

### 4.6 `deriveToolLifecycle` — "is this tool running?"

Port exactly (`toolLifecycle.js`). A tool is **closed** iff: it has a jsonl `tool_result` OR a `tool_done` hook, OR an **exit barrier** landed after it, OR (unless turn-exempt) a **turn barrier** landed after it. Barriers: turn = `hook{Stop|SessionEnd}` / `state{IDLE|ENDING|DONE}` / `lifecycle{interrupted|delivery_failed}`; exit = `exit` / `lifecycle{pty_exit}`. `resultOf` = jsonl result (richer) over hook result. **`running = !closed`** is authoritative and computed once — a done tool must never shimmer.

Also port `providerErrorMessage(reason)` (turnError humanization: `insufficient_credits`/`auth_invalid` → English, else raw) and `failureKind(tool)` (`isError` → `/^denied|permission mode|denied by policy/i` ? "denied" : "failed").

### 4.7 Git verb detection (`gitActions`/`buildSummary`)

Port the `GIT_CMD_RE` regex + `GIT_VERBS` map so `Bash` rows get git-aware labels ("Committed {sha}", "Pushed", "Viewed 2 diffs") and toolGroup summaries count git verbs. Commit SHAs are pulled from the result via `/\[[^\]\n]*\b([0-9a-f]{7,40})\]/`. `buildSummary` (generic lane) and `buildWorkerSummary` (worker lane, via `WORKER_TOOL_SPECS[name].summary`) produce the group summary strings.

### 4.8 `attachAskUserAnswers`

After the block list is built: for each `AskUserQuestion` tool block, look ahead ≤3 blocks for a `user` block starting "My answers to your questions:"; if found, set it as the tool's result and **remove** that user block (the answer is shown inside the tool card, not as a separate bubble).

### 4.9 Sort + render keys

- **Sort:** stable sort by `ts` ascending, where `ts` is the **creation-domain** time — `payload.tsTranscript` (jsonl), `payload.anchorTs ?? payload.sentAt` (synthesized messages), else event-receipt `ts`. This matters: the CLI batch-flushes transcript lines 150ms–2.5s after creation, so receipt-domain sort misplaces a drained-queue message vs. the prior turn's trailing output. `EventsWindow.ordered` currently sorts by `(ts,id)` at merge; the **block** sort must use payload creation-ts, so compute per-block `ts` in `buildBlocks` and sort there (mirror `sortBlocksByTs`).
- **Keys** (`blockKey`, for `Identifiable.id` + SwiftUI diffing): `toolGroup`→"tg-{firstToolId|ts}", `tool`→"t-{toolId|ts}", `agentRun`→"ag-{toolUseId|ts}", `terminal`→"term-{runId|ts}", else `blockId ? "{kind}-{blockId}" : "{kind}-{ts}"`. Stable keys are what make the blur-in ledger and the live→durable handoff work.

### 4.10 Live overlays (render-time merge, not in the pure pipeline)

`Messages.jsx`'s second `useMemo` overlays transient stores onto the durable blocks, then sorts. Port into the `@MainActor` view model (`AppModel`), reading the `StreamingBuffers` actors:

1. **Optimistic user bubbles** — `Outbox` items not in `queued` state → `user(optimistic:true)` blocks (queued items render as pills above the composer, not here).
2. **Live terminal** — `TerminalBuffers.run` whose `runId` has no durable `terminal` block → a `terminal(live:true)` block. Dropped once the durable lands (`removeRun`).
3. **Live thinking** — `ThinkingBuffers.active` on the **reasoning** channel whose `blockId` has no durable block → a `thinking(live:true)` block. **The text channel is deliberately NOT overlaid** — assistant text streams too fast for the per-token blur to register, and a live text block would suppress the durable block's blur-in (shared `blockId` reuses the instance as already-revealed). The durable assistant block blurs in on arrival instead.
4. **Live goal-check** — `LoopCheckBuffer.check` for the worker → the `GoalCheckLineView` (shown only while the worker is idle under an active check; a busy continuation hands off to the normal spark).

Then re-sort by `ts`. The overlay re-sort must NOT re-run the parse (the parse is the expensive full-scan; overlays are a cheap second pass) — mirror the two-`useMemo` split.

---

## 5. Renderer design (SwiftUI)

### 5.1 Assistant Markdown prose (`AssistantMessageView`) — Tier 1, the centerpiece

The Mac runs `renderMarkdown` = **Marked** (gfm, `breaks:true`, raw HTML escaped, mermaid fence → placeholder) → **DOMPurify** → `dangerouslySetInnerHTML`, styled by `.md-prose`. The native port needs a **full-GFM Markdown renderer that emits SwiftUI views** (not an attributed string — code fences, tables, blockquotes, and per-block copy buttons need real view nodes). See §5.4 for the library choice.

Target rendering (paper/serif reconciliation of `.md-prose`):
- **Body:** `EosFont.bodySerif`, `.lineSpacing(4)`, `EosColor.ink`. Long tokens wrap (no h-scroll).
- **Headings h1–h6:** serif, semibold, `EosColor.ink`; sizes map `--text-2xl/xl/md/base` → `EosFont.titleSerif`/`heading`/`bodySerifEmph`. Top margin ~16, bottom ~8.
- **Paragraph** bottom margin ~10. **Lists** indent ~22, marker `inkTertiary`, item gap ~2. **Bold** semibold `ink`; **em** italic.
- **Inline code:** `EosFont.mono` (~13pt), `EosColor.bgSunken` fill, r=3, padding 2×5.
- **Code fence:** mono card — `EosColor.surface` fill, `hairline` border, r=6, padding 10×14, line-height 1.6, **horizontal scroll**, syntax-highlighted (§5.4), **copy button** pinned top-right (§6.5).
- **Table:** header row `bgSunken`, cell borders `hairline`, row-hover n/a on iOS.
- **Blockquote:** left accent bar + indented; **hr:** hairline; **links:** coral, underline on tap.

**Markdown parse cache:** the Mac keeps an LRU(400) `text→html` cache. Mirror with an `NSCache`-backed `text → [MarkdownNode]` (or `text → rendered view tree`) cache so re-mounting a transcript doesn't re-parse every block.

### 5.2 `MessageRowView` — the action row (Tier 1)

Wrapper for `MESSAGE_ROW_KINDS`. On the Mac it's a hover-revealed row (`.msg-actions`, absolutely positioned in the block gap). On iOS there is no hover → the action row shows **on tap/long-press** (or always-visible, muted, beneath the message — decide in §5 open questions). Contents:
- **Copy** (always) — copies `copyText`.
- **Rewind** (user blocks only, and only if `backendCaps(worker.backend_kind).rewind`) — async; busy/error states dim/redden the button; on success the transcript forks. iOS: same call path (`AppModel.rewind`), just a different affordance.
- **Timestamp** — relative (`fmtTimeAgo`), full datetime on long-press.

`02` §3.7 already specs the assistant action row as `CircularIconButton`s (copy/retry/share, TTS/thumbs stubbed) — **reconcile:** the *copy + timestamp + rewind* set from the Mac is the real behavior; render extra `02` icons (share/TTS/thumbs) as disabled stubs per `02`'s note, or omit. Do not invent behavior.

### 5.3 `ToolItemView` — the universal tool chrome (Tier 1)

Header = a `DisclosureRowView` (§6.3): `[verb][space][file-chip | AgentLink][arg-summary][headerBadge][failure-badge][diff-stats][chevron]`.
- **verb:** `inkSecondary`, shimmers (§6.4) while `running`.
- **file:** `ink`, semibold; a `ti-link` if `filePath` set (tap → `FileViewerSheet`, deferred) or an `AgentLink` if `agentRef` set (tap → select worker; iOS has no Cmd-click split, so single behavior).
- **arg-summary:** `inkTertiary`, `caption`, 1-line truncate.
- **headerBadge:** loop pill (spawn) / status chip (workflow) / task-status badge — right-aligned.
- **failure:** `denied`/`failed` badge; the whole row tints (`failedSoft` background).
- **diff-stats:** `+add` (green) `-del` (red).
- Expanded → `view.detail(tool)`. Non-expandable if `expandable==false` (e.g. running worker tool with empty body).

### 5.4 Code syntax highlighting + mono font — **library decision**

The Mac highlights code via **highlight.js** (github-dark-dimmed theme; the `--hl-*` tokens in `styles.css` are its palette) inside CodeMirror/async workers, and renders prose code fences through the same theme. Two needs on iOS: (a) a mono font matching the Mac; (b) syntax highlighting matching highlight.js.

**Mono font:** `02` §1.3 maps `mono` to **SF Mono** (`design: .monospaced`, zero-dependency). The Mac uses **JetBrains Mono**. For a code-heavy transcript that must read 1:1 with the Mac, **recommend bundling JetBrains Mono** (OFL, free) as `EosFont.code` and keeping SF Mono for tiny inline meta (ids/cost) where `02` already committed to it. This is a **decision to confirm** (§8) — SF Mono is fine for v1; JetBrains Mono is the fidelity upgrade. Add via `project.yml` by dropping the `.ttf`s in `EosRemote/Resources/Fonts/` and listing them under the app target (XcodeGen globs the folder; register in Info.plist `UIAppFonts`).

**Syntax highlighting — recommend [Highlightr](https://github.com/raspu/Highlightr):**

| Option | What | Pro | Con |
|---|---|---|---|
| **Highlightr** ✅ | Wraps **highlight.js** in a bundled JS runtime (JavaScriptCore), returns an `NSAttributedString`; ships highlight.js themes including **github-dark-dimmed** | **Exact same engine + theme as the Mac** → identical tokenization/colors (highest fidelity). ~190 languages. Attributed-string output drops into a `Text`/`UITextView`. | Bundles a JS blob + runs JSC (startup/per-block cost — mitigate with an off-main-actor highlight + the parse cache); theme colors are dark (must map to a light-paper variant or accept the dark code card). |
| **Splash** | Pure-Swift Swift-only highlighter | No JS, tiny, fast, native | **Swift-only** (Eos transcripts are polyglot: TS, bash, JSON, py…) → wrong/no highlighting for most fences. Different palette from highlight.js. Disqualifying for a general transcript. |

**Recommendation:** **Highlightr**, running highlight.js with a **light** theme (e.g. `github` or a paper-tuned variant) so code cards sit on `EosColor.surface`, OR keep github-dark-dimmed on a dark code card (an intentional inset, like many paper editors) — a **decision to confirm** (§8). Rationale: same engine as the Mac = the only way to *match* highlighting rather than approximate it; Splash cannot cover the language mix. Highlight **off the main actor** and feed the `[MarkdownNode]` cache so a re-mounted transcript pays nothing.

Add via SPM in `ios/project.yml`:
```yaml
packages:
  Highlightr:
    url: https://github.com/raspu/Highlightr.git
    from: "2.2.0"
# under targets.EosRemote.dependencies:  - package: Highlightr  product: Highlightr
# (also add to EosRemoteKit if highlighting is done in the kit; recommend keeping it in the app target)
```

### 5.5 Rich-text segmentation (user bubbles / task / reports) — Tier 1

`MessageUser` / `MessageTask` / `MessageReport` bodies are **not Markdown** — they're plain text with decorated segments (`richText.jsx` `segment()` + ordered rules). Port a Swift `TextSegmenter` that applies ordered, disjoint rules over the still-plain runs and builds an `AttributedString` (or a `Text` concatenation for tappable pills):
- **URLs** (`URL_RE`, http/https, stops before trailing punctuation) → coral tappable link.
- **cwd shortening** — replace `{cwd}/` with `@` in user text.
- **attachment labels** → highlight chip; **paste-pill** tokens → pill; **slash-command** tokens → `SlashPill`.
- User attachments (images/files/folders) render as a chip row above the bubble (image → thumbnail w/ lightbox on tap).

### 5.6 Mermaid — **the one place a WKWebView island may be justified (flag for owner)**

The Mac renders ```` ```mermaid ```` fences to SVG via the `mermaid` npm lib inside the WKWebView (`lib/mermaid.js` — theme-var mapping, `htmlLabels:false` WebKit workaround, offscreen measure host, LRU SVG cache). There is **no native Swift Mermaid renderer.** Options:

1. **Defer / render source** (recommend for v1) — show the mermaid fence as a plain mono code card (its source), same as any code block, with a small "diagram" affordance. Diagrams are rare in agent transcripts; deferring keeps the port 100% native and unblocks Phase 4.
2. **Tiny WKWebView island** (recommend as the *follow-up*, and the **only** sanctioned web view in the app) — a single-purpose `WKWebView` that loads a minimal HTML shell bundling `mermaid.min.js`, receives the fence source, renders SVG, and reports its height back (so the SwiftUI card sizes to content). This mirrors the Mac's exact renderer (identical output) and is **isolated to this one block kind** — not a transcript-wide web view. Port `sanitizeMermaidSource` + the theme-var mapping into the shell.

**Flag to owner:** Mermaid is the single component where re-using the Mac's web renderer (as a contained island) is defensible, because it has no native equivalent and its correctness is non-trivial. Everything else is native. Recommendation: ship §1 (source card) in Phase 4, add the §2 island only if diagrams prove common. This is the one explicit "web view may be justified" call the brief asks us to surface.

### 5.7 Find bar

`FindBar`/`usePageFind` (⌘F, DOM ranges) has no native transcript equivalent. **Drop** for v1 (native scroll has no cross-view find). If needed later, a native `.searchable` over block text with scroll-to-match is the port — deferred, not part of the backlog.

### 5.8 Diff hunk rendering (`diff.jsx`) — Tier 1 (Edit/MultiEdit)

Port `buildDiffHunks` (LCS over lines) and `patchToHunks` (structured `patch` → absolute line numbers), plus `inlineDiff`/`inlineDiffRanges` (char-level common-prefix/suffix trim → highlighted changed span). Each hunk row → an `HStack`: line# (`inkTertiary`, mono) + sign (`+`/`-`/` `) + text (mono) with the changed span wrapped in an inline highlight (`ed-hl-add` green wash / `ed-hl-del` red wash). Row background: add → `runningSoft`, del → `failedSoft`, ctx → clear. `singleEditStats`/`multiEditStats` (LCS add/del counts) feed the header diff-stats chip. Also port `stripCatLineNumbers` (Read/Write previews: strip `cat -n` `\d+\t` prefixes) and `parseAskAnswers` (§4.8 answer parsing).

---

## 6. Fidelity notes (reproducing the Mac's motion & interaction in SwiftUI)

### 6.1 Blur-in reveal / streaming animation

The Mac's signature reveal (`blurInReveal.js` + `@keyframes msg-blur-in`): freshly arrived words fade from `opacity:0, blur(7px), translateY(3px)` → `opacity:1, blur(0), translateY(0)` over **0.22s ease**, staggered per word (`WORD_DELAY_MS 14ms`, capped at `MAX_STAGGER 600ms`). A block that grows across polls animates **only its appended tail** (`fromWord` cursor). History is seeded as already-revealed (a module ledger keyed `sessionId:blockKey`) so only post-entry output animates; the live→durable handoff reuses the same `blockId` so the reveal state carries without reflash.

**SwiftUI port:**
- Per-word blur is expensive to do literally with 100s of animated `Text` spans. Recommend a **per-block reveal**: the whole new block (or its appended tail) transitions in with `.opacity` + `.blur(radius:)` + `.offset(y:)` animated to zero over 0.22s ease, using `.transition(.modifier(active:identity:))` on insert. For streaming (thinking/assistant), animate the **tail delta**: split the block into "settled prefix" (no animation) + "fresh suffix" (animates) using the same `fromWord` cursor idea, keyed by a per-block reveal cursor in the view model.
- **Reveal ledger:** port the `animationLedger` (Set of `sessionId:blockKey`) into the view model — seed the initial page as revealed after the first scroll settles; only blocks arriving after entry animate. This is what stops the whole transcript from flashing on open.
- Respect **Reduce Motion** (`02` §4.2): duration → 0 (mirror the Mac's `prefers-reduced-motion` guard).
- `blockId`-keyed identity (§4.9) makes the live→durable swap reuse the SwiftUI view instance → no re-animate.

### 6.2 Processing/thinking spark

`@keyframes spark-a/spark-b` (thinking line): a 4-point sparkle (two crossed strokes) breathing on two phases — `spark-a` scales 0.55↔1 / opacity 0.35↔1 over 1.8s; `spark-b` (45° rotated) 0.55↔0.9 / 0.25↔0.7, +0.4s delay. Static variant freezes both at their 50% peak. **SwiftUI:** a small `Canvas`/`Shape` (or the `Sunburst` from `02` §2.8 at ~14pt) with a `.repeatForever` `.easeInOut(1.8)` scale+opacity animation on two layers; the static variant is the frozen peak. Color `EosColor.coral`.

### 6.3 Disclosure collapse

`DisclosureRow`: content-sized hit area, chevron rotates 90° on expand (`transition: transform 150ms`), verb/chevron brighten on hover. **SwiftUI:** a `Button` row + `Image(systemName:"chevron.right")` with `.rotationEffect(open ? 90° : 0)` animated `.easeInOut(0.15)`; expanded content in a `.transition(.opacity.combined(with:.move(edge:.top)))`. No hover on iOS → brightening is dropped (or a pressed state). The Mac holds the scroller while expanding (grows downward) — on iOS `LazyVStack` + `.defaultScrollAnchor(.bottom)` handles growth; ensure expand doesn't yank the scroll (test).

### 6.4 Tool running-shimmer + failure states

- **Shimmer** (`@keyframes ti-shimmer`): a gradient sweeps across the verb text (`--fg-dim`→`--shimmer`→`--fg-dim`, `background-clip:text`, 8s linear infinite) — a shimmering-text effect while `running`. **SwiftUI:** a masked linear-gradient sweep over the verb `Text` (a `LinearGradient` in an `.overlay` masked by the text, animated `.offset` `.repeatForever(8s linear)`), or the simpler **pulsing opacity** if the gradient-text proves fiddly. The `agent-card-title` uses the same shimmer while running.
- **Failure:** `failureKind` → the row gets a `denied`/`failed` badge and a tinted background (`ti-failed-state`); the Detail shows a `FailureBanner` (the error text). Port: `denied` → `waiting` amber-ish or a distinct denied color; `failed` → `failedSoft` background + `failedDot` badge text.
- **Running dim:** `.ti-running` sets `opacity:0.7` on the header — mirror.

### 6.5 Code-fence copy button

`codeBlockCopy.js` injects a copy button per fence (top-right, appears on hover, check-mark for 1.5s on copy). **SwiftUI:** a `CircularIconButton`(`doc.on.doc`) overlaid top-right of the code card (`02` §2.1); tap copies the fence's raw text, swaps to `checkmark` for 1.5s. Always-visible-but-muted on iOS (no hover). The Read/Write/Skill `file-path-bar` copy buttons and the generic-card section copy buttons follow the same pattern.

### 6.6 Terminal live-tail & spinner

`TerminalCard`: while live+!done, auto-scroll the output to bottom on each chunk; `tc-spin` spinner in the head; a stop button (calls `killTerminal`). Fresh entrance = the same 0.22s blur-in, settled after 320ms. **SwiftUI:** an inner `ScrollViewReader` scrolling to the last line on `output` change; a `ProgressView().controlSize(.mini)` spinner; stop `Button`→`AppModel.killTerminal`. Done → `✓`/`✗ {code}` in `running`/`failed` tint.

---

## 7. iOS-specific adaptations (behaviors with no direct mobile analog)

| Mac behavior | iOS adaptation |
|---|---|
| `ui.openFileViewer(path)` (side-panel file/diff viewer) | Open a `FileViewerSheet` (deferred; not in the transcript backlog). Until built, a file-chip tap copies the path or is inert. |
| `AgentLink` Cmd-click → open in split pane | iOS has no split; single tap = select/navigate to that worker (`AppModel` selection). |
| `revealFile(path)` (worktreePreserved "Reveal", Finder) | No Finder on iOS → button copies the path (or is hidden). |
| Hover-revealed action rows / copy buttons | Tap/long-press to reveal, or always-visible muted (decide §8). |
| ⌘F find bar | Dropped (§5.7). |
| Scroll memory / anchor / stick-to-bottom (`Messages.jsx`) | `WorkerDetailView` already uses `.defaultScrollAnchor(.bottom)` + `hasOlder` paging (`02` keeps it). The per-agent saved-position and blur-in seeding port into the view model. |

---

## 8. Priority tiers (Phase-4 build order) & open decisions

### 8.1 Tier 1 — the transcript is legible and live
`AssistantMessageView` (serif Markdown + code highlight, §5.1/5.4) · `UserMessageView` (rich-text, §5.5) · `ThinkingLineView` (§1 #3) · `ToolItemView` core (Read/Edit/MultiEdit/Write/Bash + `GenericToolCardView`, §2.1/2.7) + diff hunks (§5.8) · `ToolGroupView` (§1 #4) · `AgentBlockView` (§1 #6) · `MessageReportView` (report/directive, §1 #7/8) · `ProcessingLineView` (§6.2). Parser: full pipeline §4.1–4.9 + live overlays §4.10. **Exit criterion:** every block/tool renders *something* correct (unknowns via GenericToolCard), prose is serif, code highlights, tools expand, live thinking/terminal stream.

### 8.2 Tier 2 — the named cards & orchestration surfaces
`TerminalCardView` (§1 #12/§6.6) · `WorkflowToolDetailView` + `WorkflowReportView` (§3) · worker cards spawn/kill/message/get/list (§2.3) · peer cards (§2.4) · task/todo cards (§2.5) · `LoopStatusCardView` + `LoopCheckLineView` + `GoalCheckLineView` (§1) · `AskUserQuestionDetailView`/`AskUserDetailView` (§2.2) · `NotifyDetailView` · `SkillDetailView` · `TaskFromView` · datetime/ToolSearch/ScheduleWakeup/TaskOutput/create/list-available (§2.6/2.3).

### 8.3 Tier 3 — the long tail
`SystemLineView` (deliveryFailed/cleared/turnError) · `GitLineView` (push/pull) · `WorktreePreservedView` · Mermaid island (§5.6, if pursued) · Find bar (if pursued).

### 8.4 Open decisions to confirm before building
- **Mono font (§5.4):** bundle **JetBrains Mono** for code (matches Mac, recommended fidelity upgrade) vs. keep `02`'s SF Mono default. Affects `project.yml` (font resource) + `EosFont.code`.
- **Code theme (§5.4):** Highlightr with a **light** highlight.js theme on `EosColor.surface` (matches paper) vs. **github-dark-dimmed** on a dark code card (matches Mac exactly, but a dark inset on paper). 
- **Highlightr dependency (§5.4):** accept the bundled-JS/JSC cost for exact-match highlighting (recommended) vs. Splash (native, but Swift-only → wrong for polyglot transcripts, not recommended) vs. no highlighting v1.
- **Action row affordance (§5.2/6.5):** tap/long-press-to-reveal vs. always-visible-muted for copy/rewind/timestamp and code-copy buttons.
- **Mermaid (§5.6):** defer to source card (recommended v1) vs. build the contained WKWebView island (the one sanctioned web view).
- **Block model (§4.2):** confirm the typed-payload `Block.Payload` enum replaces the current `text`-only `Block` (recommended) — this is the one breaking change to `Domain.swift`/`MessageNormalizer.swift`; `WorkerDetailView`/`FleetView` consume `AppModel`, not `Block` internals, so blast radius is the kit + `MessageView`.

---

## 9. Traceability (source → planned view)

Quick index for implementers — Mac file → SwiftUI target.

| Mac source | SwiftUI target(s) |
|---|---|
| `Messages.jsx` `renderBlock` | `MessageView` dispatcher (§1) |
| `MessageUser.jsx` | `UserMessageView` + `TextSegmenter` (§5.5) |
| `MessageAssistant.jsx` + `lib/markdown.js` | `AssistantMessageView` + Markdown renderer + Highlightr (§5.1/5.4) |
| `ThinkingLine.jsx` | `ThinkingLineView` |
| `MessageRow.jsx` | `MessageRowView` (§5.2) |
| `ToolItem.jsx` + `toolViews.jsx` | `ToolItemView` + `ToolView` registry (§2/5.3) |
| `ToolGroup.jsx` | `ToolGroupView` |
| `ToolDetail.jsx` | the ~25 `*DetailView`s (§2) |
| `WorkerToolCard.jsx` + `lib/workerTools.js` | `WorkerToolBodyView` + `WorkerToolSpecs` (§2.3) |
| `WorkflowCard.jsx` | `WorkflowToolDetailView` + `WorkflowReportView` (§3) |
| `AgentBlock.jsx` / `AgentViewer.jsx` | `AgentBlockView` / `AgentViewerSheet` (§1 #6) |
| `TerminalCard.jsx` | `TerminalCardView` (§6.6) |
| `MessageReport.jsx` | `MessageReportView` (§1 #7/8/9) |
| `MessageTask.jsx` | `TaskFromView` |
| `MessageLoop.jsx` / `LoopCheck.jsx` / `LoopStatus.jsx` | `MessageLoopView` / `LoopCheckLineView`+`GoalCheckLineView` / `LoopStatusCardView` |
| `ProcessingLine.jsx` | `ProcessingLineView` (§6.2) |
| `DisclosureRow.jsx` | `DisclosureRowView` (§6.3) |
| `AgentLink.jsx` + `lib/agentName.js` | `AgentLinkView` + name/definition helper |
| `lib/messageParser.js` | `MessageNormalizer` pipeline (§4) |
| `lib/toolLifecycle.js` | `deriveToolLifecycle` (§4.6) |
| `lib/diff.jsx` | diff-hunk helpers (§5.8) |
| `lib/blurInReveal.js` + `animationLedger` | reveal transition + ledger (§6.1) |
| `lib/mermaid.js` | Mermaid source card / WKWebView island (§5.6) |
| `lib/richText.jsx` / `slashTokens`/`pasteTokens`/`attachmentTokens` | `TextSegmenter` rules (§5.5) |

---

## 10. Appendix — exact per-block CSS reference

The precise `styles.css` values, so implementers set real numbers (not approximations). Recolor per §0.3 (Mac token → `EosColor`); keep the geometry. `text-sm` = 13pt, `text-base` = 14pt, `text-md` = 15pt, `text-xs` = 12pt, `text-2xl` = 19pt, `text-xl` = 17pt. `color-mix(X n%, transparent)` → `EosColor.X.opacity(n/100)` (use the paper-theme state colors).

**User bubble** — `.msg-user .b`: bg `bubble-user-bg` (paper: `coralWash`), pad 7×13, radius 10, `text-base`, max-width 80%, line-height 1.5, pre-wrap. Column, right-aligned. `.msg-actions`: absolute top:100%, gap 8, height 22 (18+4), opacity 0→1 on hover. `.msg-action-btn`: pad 2, radius 3, `fg-faint`→`fg` on hover. `.msg-time`: `text-xs`, `fg-faint`. Pills (`.att-hl`/`.paste-pill`): coral text, coral@14% bg, radius 5, pad 1×5.

**Prose** — `.md-prose`: `text-base`, line-height 1.65 (paper: serif + `.lineSpacing(4)`). `p` margin 0 0 10. `h1/2/3` margins 16 0 8, weight 600; sizes `text-2xl`/`xl`/`md`; `h4–6` `text-base`. `ul/ol` margin 4 0 10, padding-left 22; `li` margin 2 0, marker `fg-faint`. `code` (inline): mono `text-sm`, pad 2×5, bg `surface-2`, radius 3. `pre`: margin 8 0 12, pad 10×14, mono `text-sm`, line-height 1.6, bg `surface`, border 1 `border`, radius 6, overflow-x auto. `blockquote`: pad 6×14, border-left 3 `border`, `fg-dim`. `table`: border-spacing 2, `th` pad 6×14 weight 500 bg `surface-3` radius 4, `td` pad 6×14 bg `surface-2` radius 4. `a`: `accent`, underline on hover. `.code-copy-btn`: absolute top6 right6, 26×26, bg `surface-2`, border 1, radius 5, opacity 0→1 on hover, `.copied`→`ok`.

**Thinking / spark** — `.thinking-line`: gap 7, `text-sm`, `fg-faint`; `.mono` child line-height 1.55, pre-wrap. `.spark`: 28×28, color `accent`, two crossed strokes via ::before/::after masked by radial gradients. `spark-a` (::before) `1.8s ease-in-out infinite`: 0/100% `rotate(0) scale(0.55) opacity .35`, 50% `scale(1) opacity 1`. `spark-b` (::after) same +0.4s delay: 0/100% `rotate(45°) scale(0.55) opacity .25`, 50% `rotate(45°) scale(0.9) opacity .7`. Static = frozen at 50% peak. `.thinking-sep`: 3×3 dot `fg-faint`. `msg-blur-in` `0.22s ease forwards`: `opacity 0→1, blur(7px)→0, translateY(3px)→0`.

**Tool item / group** — `.disclosure-row`: fit-content width; chevron `rotate(90°)` when expanded, `transition transform 150ms`. `.tool-group-header`: gap 8, pad-block 9, `text-base`, `fg-dim`→`fg` hover. `.tool-group-list`: bg `surface`, border 1 `border`, radius 10, pad 4×12, margin-top 4. `.tool-item-header`: gap 5, pad-block 5. `.ti-verb`: `fg-dim`. `.ti-file`: weight 600, `fg`; `.ti-link` underline on hover (offset 3). `.ti-arg-summary`: `fg-faint`, `text-sm`, 1-line ellipsis. `.ti-chev`: `fg-faint`. `.ti-loop-badge`: margin-left auto, mono `text-xs`, pad 2×5, radius 4, coral text, coral@12% bg. `.ti-stats` `text-sm`: `.ti-add`→`ok`, `.ti-del`→`err`. `.ti-shimmer`: 8s linear infinite gradient sweep over text. `.ti-running`: opacity 0.7. `.ti-failed`: `text-xs`, pad 1×6, radius 3, uppercase, weight 600; **denied** → err@18% bg + err text; **failed** → warn@18% bg + warn text. `.ti-failed-state .ti-file`: line-through err. `.tool-failure-banner`: margin 6/12/4, pad 6×10, radius 4, warn@10% bg (denied: err@10%), `text-sm`, `fg-dim`.

**Tool detail bodies** — card chrome (read/bash/edit/generic): margin 4 0 8, border 1 `border`, radius 10, overflow hidden, bg `surface`. `.file-path-bar`: flex space-between, pad 8×14, mono `text-sm`, `fg-dim`, `.fp-copy` opacity 0→1 on card hover. `.code-preview`: mono `text-sm`, line-height 1.65; `.cp-num` width 28, right-aligned, `fg-faint`; `.cp-text` pre-wrap `fg`; `.cp-fade` opacity .35; `.hl-heading` `accent` weight 600. `.bash-label` pad 8/14/0 weight 600; `.bash-prompt` `fg-faint`; `.bash-cmd-text` `ok`; `.bash-output` pad 6×14 line-height 1.6 `fg-dim` pre-wrap. `.edit-diff` mono `text-sm` line-height 1.65: `.ed-line.ed-del` bg err@13% (num+sign err), `.ed-line.ed-add` bg ok@13% (num+sign ok); `.ed-num` width 28 right; `.ed-sign` width 14; `.ed-hl-del` err@30% radius 2, `.ed-hl-add` ok@30% radius 2. `.gd-section`: `text-xs`, weight 700, uppercase, letter-spacing .4, `fg-faint`, margin-bottom 5; `.gd-key` `fg-dim`, `.gd-val` weight 600 `fg`; `.gd-output-text` mono `text-sm` line-height 1.6 `fg-dim` pre-wrap; `.gd-running` italic `fg-faint`. Blocks separated by border-top 1 `border`.

**Workflow / agent** — `.wf-status`: `text-xs`, pad 1×7, radius 4, uppercase, mono; passed→ok@16%+ok, failed→err@18%+err, running→accent@16%+accent, stopped→warn@18%+warn, pending→fg-faint@20%+fg-dim. `.wf-result`: mono `text-sm` line-height 1.55 `fg-dim` pre-wrap, max-height 360 scroll. `.agent-card` (running): flex gap 12, bg `surface-2`, radius 12, pad 12×16, max-width 420, hover→`surface-3` brightness 1.15; `.agent-card-title` `text-md` weight 500 ellipsis; `.agent-card-status` `text-sm` `fg-dim`. `.agent-done-text` `text-base` `fg-dim`. `.agent-result` (done): pad 10×14, bg `surface`, border 1, radius 8, mono `text-sm` `fg-dim`, max-height 300 scroll. Agent viewer: `.av-prompt-bubble`/`.av-output-bubble` bg `surface`, radius 10, pad 12×14, `text-base` `fg-dim` line-height 1.55.

**Terminal / loop / git / task** — `.terminal-card`: border 1, radius 10, bg `surface`, mono `text-sm`. `.tc-prompt` `amber` (use `waiting`), `.tc-cmd` `fg`; `.tc-exit.ok` ok+ok@12%, `.tc-exit.err` err+err@12%; `.tc-spin` 10×10, `verify-spin 0.7s linear infinite` (amber border, amber top); `.tc-out` pad 4/14/10 line-height 1.6 `fg-dim` pre-wrap, max-height 280 scroll; `.tc-note` `text-xs` `fg-faint`. `.msg-task`: pad 12×16, bg accent@6%, border 1 accent@12%, radius 10; `.msg-task-icon` accent opacity .7; body `text-base` line-height 1.6. `.loop-status`: pad 10×14, radius 10, bg accent@6%, border accent@14%; passed→ok@7%/ok@16%; exhausted/stopped→`surface`/`border`; dot 7×7 accent (passed→ok, exhausted→fg-faint); label `fg` weight 600; goal `text-sm` `fg`; reason `text-sm` `fg-dim`. `.loop-check-line`: `text-xs` `fg-dim`, gap 6; ok→ok icon, escalated→warn icon. `.git-push-line`: `text-xs` `fg-dim`, gap 8; ok→ok icon, err→err icon. `.worktree-preserved`: `text-xs` `fg-dim`, pad 6×10, border 1, radius 8; `.wp-title` `warn` weight 600. `.ag-def` (definition suffix): `fg-faint` weight 400.

*Keyframes:* `verify-spin`→`rotate(360°)`; `ag-pulse`→50% opacity .45 (agent-running pulse); `ti-shimmer`→`background-position 200%→-200%`.

---

*End of spec. This is the Phase-4 implementation backlog: §1 (22 block kinds) + §2 (~40 tool cards) are exhaustive; §4 is the parser contract; §5–6 are the fidelity requirements; §8 lists the decisions to confirm before building; §10 is the exact-CSS reference.*
