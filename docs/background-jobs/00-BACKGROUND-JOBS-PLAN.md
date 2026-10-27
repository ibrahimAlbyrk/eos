# Background jobs

Everything that runs on its own behind a chat or behind Eos, in one place: a
header beacon ("N running") with a glass popover, and a **Jobs** side-panel tab.
Replaces the old corner Monitor widget (`BackgroundActivityService` +
`components/monitor/`), which only the removed claude-cli lane ever fed and
which dropped entries when the turn that started them ended.

## Kinds and where they come from

| Kind | Source | Stop |
|---|---|---|
| `shell` (background Bash) | SDK mapper → `onBackgroundTask` | `session.stopTask(taskId)` |
| `shell` (`!` command) | bus `terminal:start` / `terminal:chunk` / `terminal:done` | `TerminalRunService.kill` |
| `monitor` | SDK mapper → `onBackgroundTask` (events = carriers with `<event>`, no `<status>`) | `session.stopTask(taskId)` |
| `workflow` | agent events `workflow_started` / `workflow_completed`; progress from `publishWorkflowProgress` | `session.stopTask(taskId)` |
| `transfer` | bus `transfer:change` (only transfers seen running) | `TransferService.cancel` |
| `compaction` | `CompactionService.onRunChange` | — |
| `dream` | bus `dream:change` + `DreamService.status()` | `DreamService.requestStop` |
| `sync` | bus `sync:change` (shown only after a pass outlasts 1.5 s) | — |

Goal-loop checks are deliberately left out (they have their own indicator), and
so are subagents (the Environment panel lists them).

## SDK mapping (`manager/backends/sdk/SdkEventMapper.ts`)

- Top-level `Bash` / `Monitor` tool calls are remembered by call id; a task is
  ours only when its `tool_use_id` is one of them. A Monitor with a command
  registers as `local_bash` too, so the call — not `task_type` — tells them apart.
- Announce: `task_started` (Bash with `run_in_background`, `is_backgrounded`, or a
  Monitor), else the tool result's sidecar (`backgroundTaskId` / `taskId`) or
  text; a foreground Bash moved to the background announces on `task_updated`
  `patch.is_backgrounded`. Ambient tasks are skipped.
- Output file: only `…/tasks/<id>.output` paths (from the result text or the
  notification); learned after the start → an `output` update.
- End: `task_notification`, a carrier with `<status>`, a shell missing from
  `background_tasks_changed`, or the process going away (`stopLiveSubagents`).
  Exit code is parsed from the summary ("(exit code N)"); a non-zero "completed"
  reads as failed.
- These are **not** AgentEvents (nothing is logged); `liveSubagents` is unchanged.

## Registry (`manager/services/BackgroundJobService.ts`)

In memory, never persisted (a daemon restart empties it; SDK tasks die with the
daemon anyway). Job id `<kind>:<workerId|eos>:<source id>`. Bus topic
`jobs:change` = `{ job }` or `{ removed }`, at most every 500 ms per job, starts
and ends at once; global (not focus-filtered). Finished jobs are kept, newest 50,
until dismissed or cleared; compaction and sync vanish when they end. A removed
worker drops its jobs. Output: a shell's task file (byte offsets), a `!`
command's chunks and a Monitor's events in memory (256 KB ring).

Routes (all ui-token): `GET /api/jobs`, `GET /api/jobs/:id/output?since=`,
`POST /api/jobs/:id/stop`, `POST /api/jobs/:id/dismiss`, `POST /api/jobs/clear`.

## UI (`app/ui/src/views/jobs/`)

- `state/jobsStore.js` (load once, `jobs:change`, resync) and `lib/jobs.js` (order, filters, grouping, meta).
- `JobsBeacon.jsx` in the top-right pane's header: shown while anything runs or a
  failure is unseen; popover groups by chat (Eos for its own work); a row opens
  the Jobs tab on that job.
- `JobsPanel.jsx`: filters All / Shells / Workflows / Eos, Running / Finished, a row
  opens `JobDetail.jsx` (output tail read once a second while running; Stop,
  Ask agent to fix, Open live view, Open transfers, Open journal, Copy output,
  Go to chat, Dismiss).
- Styles: `styles/jobs.css`; the popover is `.glass-pop`.

## Later

- "Open in terminal" (`tail -f` the task file in a terminal tab) — another entry
  in `JobDetail`'s action list.
- The phone: `GET /api/jobs` + `jobs:change` are ready for it.
