// turnFold — folds the work of a finished turn (reasoning, tool calls, interim
// replies) behind one "Worked for …" row so only the final reply stays in view.
//
// Turns come from the event log (turnBounds), never from live state: a turn
// folds once its end is logged, and a folded turn never changes again — what
// the agent does later (woken by a background subagent's report, a Monitor, …)
// is a new turn below it.

import { parsePayload, isTurnBarrier, isExitBarrier } from "./toolLifecycle.js";

// The agent's own output between two prompts. Anything else (a prompt, a
// worker report, a terminal run, an error line) ends the run and stays visible.
// A visual answer ("view") belongs to the run but is always pinned in view.
// A Workflow run ("workflow") is pinned the same way: its card is the run's live view.
const WORK_KINDS = new Set(["thinking", "assistant", "toolGroup", "tool", "subagents", "agentRun", "view", "workflow"]);

// Tool calls the reader must still see once the turn folds — they stay in view
// between the fold row and the final reply.
const PINNED_TOOLS = new Set([
  "Artifact",
  "AskUserQuestion",
  "ExitPlanMode",
  "mcp__orchestrator__ask_user",
  "mcp__orchestrator__notify_user",
  "mcp__worker__send_message_to_parent",
]);

// Background subagents outlive their turn: like a workflow card, their line
// stays in view with its live status once the turn folds.
const isBackgroundBatch = (b) =>
  (b.kind === "subagents" && b.runs.some((r) => r.background)) || (b.kind === "agentRun" && b.background === true);
const isPinned = (b) =>
  b.kind === "view" || b.kind === "workflow" || isBackgroundBatch(b) || (b.kind === "tool" && PINNED_TOOLS.has(b.tool?.name));
// A run may end on the reply or on a view (the agent answered by showing).
const isFinalReply = (b) => b.kind === "assistant" || b.kind === "view";
const isAction = (b) => b.kind === "toolGroup" || b.kind === "tool" || b.kind === "subagents" || b.kind === "agentRun" || b.kind === "workflow";

const BUSY_STATES = new Set(["SPAWNING", "WORKING"]);

// "start" | "end" | null — the turn edge a log row marks. A start is the worker
// entering the busy set (or the lane's own turn start); an end is any turn
// barrier (turn end, IDLE/DONE, interrupt, exit).
function turnEdge(ev) {
  const p = ev.type === "state" || ev.type === "agent_event" ? parsePayload(ev.payload) : null;
  if (ev.type === "state" && BUSY_STATES.has(p.state)) return BUSY_STATES.has(p.from) ? null : "start";
  if (ev.type === "agent_event") {
    if (p.type === "turn") return p.phase === "started" ? "start" : "end";
    return p.type === "session" && p.phase === "ended" ? "end" : null;
  }
  return isTurnBarrier(ev) || isExitBarrier(ev) ? "end" : null;
}

// When the agent's turns started (ascending) and when the latest one ended —
// on the daemon clock the agent's blocks are stamped with.
export function turnBounds(events) {
  const starts = [];
  let lastEnd = -Infinity;
  for (const ev of events) {
    const edge = turnEdge(ev);
    if (edge === "start") starts.push(ev.ts);
    else if (edge === "end" && ev.ts > lastEnd) lastEnd = ev.ts;
  }
  return { starts: starts.sort((a, b) => a - b), lastEnd };
}

// blocks → render items: { kind: "block", block, index } | { kind: "fold", … }.
// A run is one turn's unbroken output, and it folds once that turn has ended.
// Runs whose turn still goes on come back as liveRunKeys, so the view can play
// the settle when they fold.
export function foldTurns(blocks, keyOf, { starts = [], lastEnd = -Infinity } = {}) {
  const items = [];
  const liveRunKeys = [];
  let i = 0;
  while (i < blocks.length) {
    if (!WORK_KINDS.has(blocks[i].kind)) {
      items.push({ kind: "block", block: blocks[i], index: i });
      i++;
      continue;
    }
    const turn = turnIndex(starts, blocks[i].ts);
    let end = i + 1;
    while (end < blocks.length && WORK_KINDS.has(blocks[end].kind) && turnIndex(starts, blocks[end].ts) === turn) end++;
    const runKey = keyOf(blocks[i], i);
    const finalIdx = end - 1;
    const final = blocks[finalIdx];
    const ended = lastEnd >= blocks[i].ts;
    const work = [];
    const pinned = [];
    for (let k = i; k < finalIdx; k++) {
      if (isPinned(blocks[k])) pinned.push({ kind: "block", block: blocks[k], index: k });
      else work.push(blocks[k]);
    }
    if (!ended || !isFinalReply(final) || !work.some(isAction)) {
      if (!ended) liveRunKeys.push(runKey);
      for (let k = i; k < end; k++) items.push({ kind: "block", block: blocks[k], index: k });
      i = end;
      continue;
    }
    items.push({
      kind: "fold",
      // Keyed by its reply, so older rows paging in or trimming off never re-key it.
      key: "fold-" + keyOf(final, finalIdx),
      runKey,
      work,
      durationMs: spanMs(workStart(blocks, i, starts[turn - 1]), final.ts),
    });
    items.push(...pinned);
    items.push({ kind: "block", block: final, index: finalIdx });
    i = end;
  }
  return { items, liveRunKeys };
}

// How many turns started at or before `ts`: blocks with the same count share a turn.
function turnIndex(starts, ts) {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// The work began with whichever came last: the block before it (its prompt) or
// its turn's start — a turn the agent woke up for has no prompt of its own.
function workStart(blocks, i, turnStart) {
  const prev = i > 0 ? blocks[i - 1].ts : null;
  if (prev == null) return turnStart ?? blocks[i].ts;
  return turnStart != null && turnStart > prev ? turnStart : prev;
}

function spanMs(start, end) {
  return start != null && end != null && end >= start ? end - start : null;
}
