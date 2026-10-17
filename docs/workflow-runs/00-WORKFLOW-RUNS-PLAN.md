# Workflow runs — implementation plan

Status: implemented (phases 1–6). Tests: contracts `workflow-run-schema`, core
`workflow-run`, manager `sdk-workflow-events`, `WorkflowRunService`, `routes/workflow-runs`,
UI `messageParser.workflow`, `workflowRuns`, `workflowRunsStore`, `views/agents/workflow/workflow`.

Changed while building (vs. the plan below):

- `workflow:progress` also carries the run's **end** (`status` ≠ running) — an open side-panel
  tab learns it without the transcript; the tab also re-asks every 10 s while running, since
  the stream sends progress only for conversations on screen.
- Phase **details** came in v1 after all: the UI reads the planned phases from the script's
  `meta` literal (regex, never evaluated), so the rail shows what is still ahead; the run
  record adds them for runs started from `scriptPath`/`name`.
- `selectSubagentRows` is unchanged: nothing conversation-wide lists workflow runs, and the
  tab rebuilds from `GET /workers/:id/workflow-runs/:callId`, which scans the event log itself.
- Agent transcripts are all sidechain entries: `activeBranchOf`/`transcriptView` take
  `{ sidechain: true }`.
- No capability flag for stopping: callers gate on `AgentSession.stopTask`'s presence (the
  `recallLastUserTurn` idiom). Stop needs two clicks.
- Rewind / `/compact` now also warn about running workflows (`subagentStopConfirm`).
- The legacy workflows-editor CSS (`.wf-*`, `.wfe-*`, `--wfk-*`) was deleted; the one live use
  (`dream.css` merge tag) got its colour inline.

Show a Claude Code **Workflow** tool run live while it runs in a focused session: which
phase it is in, which agents are running, what each one is doing, and what came out.
Today the call renders as a generic "Used Workflow" row and nothing else — the daemon drops
every workflow signal. Designs chosen: **A · Inline run card** (transcript) + **B · Flow
graph panel** (side-panel tab) — canvas: https://claude.ai/artifact/8vnECEhMaemQmRqSVs5G2V.

## Where the data comes from (verified)

Only focused sessions can call Workflow (it is blocked for orchestrators/workers), and they
always run on the claude SDK lane — the claude-cli lane is gone. So there is one source:
the SDK message stream of the focused session.

| Signal | What it carries |
|---|---|
| `tool_use_result` of the Workflow call (`WorkflowOutput`) | `taskId`, `runId`, `workflowName`, `summary` (= `meta.description`), `scriptPath`, `transcriptDir` |
| `system/task_started` (`task_type: "local_workflow"`) | `task_id` ↔ `tool_use_id`, `workflow_name` |
| `system/task_progress` | `usage {total_tokens, tool_uses, duration_ms}`, `description` (`"<phase>: <label>"` of the latest agent), and an **undocumented `workflow_progress`** array (below) |
| `system/task_updated` | status patch (`running`/`completed`/`failed`/`killed`/`paused`) |
| `system/task_notification` | final `status` (`completed`/`failed`/`stopped`), `summary`, `usage`, `output_file` |

`workflow_progress` is the run's full snapshot, not typed in `sdk.d.ts` but sent by the
bundled binary (0.3.284; `Ove()` → `workflow_progress: e.workflowProgress`). Entries merge by
`type:index`:

- `{type:"workflow_phase", index, title}`
- `{type:"workflow_agent", index, label, phaseIndex, phaseTitle, agentId, model, state, queuedAt, startedAt, lastProgressAt, lastToolName, lastToolSummary, promptPreview, resultPreview, tokens, toolCalls, attempt, cached?, blocked?, error?}` — `state` ∈ `start | progress | done | error | cancelled`
- `{type:"workflow_log", message}` — the script's `log()` lines

The CLI already throttles it: a full snapshot rides every progress message that changes an
agent's state, plus one per interval for pure tool ticks; the rest carry usage only.
Per-agent transcripts live in `transcriptDir/agent-<agentId>.jsonl` (+ `.meta.json` with
`workflowPhase`), written live. A real run's records (`~/.claude/projects/…/workflows/<runId>.json`)
confirm the same entry shapes.

Not in the data: which agent fed which (pipeline edges) and each phase's `detail` text
(only in the script's `meta`). Workflow child agents' messages do **not** reach the session
stream (0 child-tool rows for the genui-build run in `state.db`).

## Changes from the canvas

- **B's per-agent arrows go.** `review:bugs → verify:bugs·1..3` was invented; the snapshot has
  no parentage. The graph is phases as columns, agents stacked in their column by index,
  one connector per phase boundary. Inferring edges from labels would be wrong too often.
- **A's finished card shows the script's `log()` lines** + the notification summary instead
  of the confirmed/dismissed list — a workflow's result is arbitrary JSON; the logs are the
  author-written, human-readable account. Per-agent `resultPreview` sits on each agent row.
- **Phase detail text is dropped in v1** (titles only). Later: parse `meta` as the pure
  literal it is required to be (never evaluate the script).

## Design

### Daemon

- **contracts** (`canonical.ts`): two persisted `AgentEvent` kinds and one shared snapshot
  schema.
  - `workflow_started {callId, taskId, runId?, name, description?, transcriptDir?}`
  - `workflow_completed {callId, taskId, status: completed|failed|stopped, summary?, usage?, snapshot}`
  - `WorkflowRunSnapshot {phases[{index,title}], agents[…normalized…], logs[], usage}`
- **core** (`domain/workflow-run.ts`, pure): `applyWorkflowProgress(prev, raw)` — tolerant
  merge of the raw entries into the snapshot; unknown fields dropped, unknown `state` →
  `running`, `start` without `startedAt` → `queued`. The undocumented field is parsed here
  and only here, so a CLI change breaks one function and its fixture test.
- **SdkEventMapper**: record Workflow call ids; read `WorkflowOutput` from `tool_use_result`
  and `workflow_name` from `task_started` → `workflow_started`; route `task_progress` /
  `task_updated` / `task_notification` for those task ids → a transient
  `workflow_progress` signal and the final `workflow_completed` (today `resolveBgEntry`
  drops them on purpose; that test changes). Running workflows join `liveSubagents` /
  `stopLiveSubagents`, so:
  - **compaction waits** — today an idle-edge compaction would `replaceContext` and kill a
    running workflow;
  - the turn-end notification waits for the result turn, as it does for background agents;
  - a session restart closes the card as `stopped` instead of leaving it spinning.
- **`WorkflowRunService`** (manager/services): latest snapshot per `(workerId, callId)` in
  memory; publishes bus topic **`workflow:progress`** at most 2/s per run (never persisted —
  logging every tick would evict transcript rows from the 20 000-row `events` cap).
  Persisted rows per run: exactly two (`workflow_started`, `workflow_completed`).
- **Routes** (ui-token, same remote tier as interrupt):
  - `GET /workers/:id/workflow-runs` — live snapshots for hydration/resync.
  - `GET /workers/:id/workflow-runs/:callId/agents/:agentId` — the agent's transcript as
    worker-event rows via `services/pty/transcriptRows.ts` (tail ≤ 200). Path built only from
    the daemon's own `transcriptDir` + an `agentId` matching `^[a-z0-9]{6,40}$`.
  - `POST /workers/:id/workflow-runs/:callId/stop` → `session.stopTask(taskId)`. We declare
    `perTaskStopAffordance: true`, so an interrupt spares workflows and there is no other way
    to stop one today. New optional `AgentSession.stopTask` + capability flag; the UI shows
    Stop only when the capability is there.
- **`selectSubagentRows`** keeps Workflow calls and `workflow_*` rows so a paged transcript
  still finds them.

### UI

- **Parser**: a Workflow call becomes its own block `{kind:"workflow"}` (like genui `view`),
  pinned in `turnFold`, and a running one keeps its turn unfolded.
- **`lib/workflowRuns.js`** (pure): block + persisted events + live snapshot → view model
  (phases with status/progress, agents with identity via `assignIdentities`, totals, elapsed).
- **`state/workflowRunsStore.js`**: keyed `workerId:callId`; fed by `workflow:progress`
  (`useLive`), hydrated from the route on mount/resync; finished runs read the snapshot in
  `workflow_completed`.
- **A · `WorkflowCard.jsx`**: tool row → card: header (name, status chip, elapsed, Stop),
  phase rail, phase groups (done ones collapsed) with agent rows — `SubagentGlyph`, label,
  shimmering `lastToolName (lastToolSummary)`, tokens, time; footer totals + "Open live
  view". Finished: rail all green, logs, totals. 1 s clock only while running.
- **B · `workflow:<workerId>/<callId>` tab** (`panelTabs`, `registerPanels`, `panelTabMeta`,
  `SidePanel` label): `WorkflowPanel` = header + `WorkflowGraph` (CSS grid columns, no layout
  engine) + `WorkflowAgentDrawer` (prompt preview, state, usage, result preview, and the
  agent's activity rows rendered with the existing tool views; refetched when that agent's
  `lastProgressAt` moves). Rebuilds from its id after a reload.
- **Styles**: new `styles/workflow-runs.css`, prefix `wr-`. The legacy `.wf-*` rules (dead
  since the old workflows feature was removed) are left alone unless we decide to delete them.
- **Prompt**: one line in a focused fragment — progress shows live in the chat, so don't send
  the user to `/workflows` (the genui-build run did exactly that; the command doesn't exist
  in Eos).

## Phases

Each phase ends green on lint + the touched suites.

1. **Contracts + core** — schemas, `applyWorkflowProgress`, fixture from a real run record.
2. **Daemon** — mapper, liveness/compaction/restart, `WorkflowRunService`, topic, routes,
   `stopTask`, `selectSubagentRows`.
3. **UI data** — parser block, `workflowRuns.js`, store, `useLive` wiring.
4. **A** — `WorkflowCard` running + finished.
5. **B** — panel tab, graph, drawer.
6. **Prompt line + CLAUDE.md** design-decision bullet.

## Tests

contracts schema; core merge (unknown states/fields, partial snapshots, real fixture);
mapper (started/progress/notification/restart, the reversed "drops workflows" case);
service throttle + hydration; routes (agent-id validation, path traversal refused, stop
without capability → 409); UI `messageParser.workflow`, `workflowRuns`, store, `turnFold`,
`panelTabs`, `WorkflowCard`, `WorkflowPanel` (static-markup style of the existing suites).

## Risks

- `workflow_progress` is undocumented and can change with an SDK bump → one parser, one
  fixture test; if it disappears the card degrades to started/elapsed/usage/finished.
- Long runs with many agents → rows virtualize only if needed; graph columns scroll.

## Later

Phase `detail` from `meta`; workflow agents in the Subagents panel; iOS; workflows in
Code-view terminal panes (they'd need a `transcriptDir` tailer).
