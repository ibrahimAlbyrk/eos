// turnFold — folds the work of a finished turn (reasoning, tool calls, interim
// replies) behind one "Worked for …" row so only the final reply stays in view.

import { isRunning } from "./subagentRuns.js";

// The agent's own output between two prompts. Anything else (a prompt, a
// worker report, a terminal run, an error line) ends the run and stays visible.
// A visual answer ("view") belongs to the run but is always pinned in view.
const WORK_KINDS = new Set(["thinking", "assistant", "toolGroup", "tool", "subagents", "agentRun", "view"]);

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

const isPinned = (b) => b.kind === "view" || (b.kind === "tool" && PINNED_TOOLS.has(b.tool?.name));
// A run may end on the reply or on a view (the agent answered by showing).
const isFinalReply = (b) => b.kind === "assistant" || b.kind === "view";
const isAction = (b) => b.kind === "toolGroup" || b.kind === "tool" || b.kind === "subagents" || b.kind === "agentRun";
const hasRunningSubagent = (b) =>
  (b.kind === "subagents" && b.runs.some(isRunning)) || (b.kind === "agentRun" && isRunning(b));

// blocks → render items: { kind: "block", block, index } | { kind: "fold", … }.
// A run that isn't over never folds: the one still streaming at the tail while
// `live`, and one whose background subagents still work — their reports wake
// the agent, which carries on in that same run. Their keys are returned so the
// view can play the settle when that same run folds later.
export function foldTurns(blocks, keyOf, { live = false } = {}) {
  const items = [];
  const liveRunKeys = [];
  let i = 0;
  while (i < blocks.length) {
    if (!WORK_KINDS.has(blocks[i].kind)) {
      items.push({ kind: "block", block: blocks[i], index: i });
      i++;
      continue;
    }
    let end = i;
    while (end < blocks.length && WORK_KINDS.has(blocks[end].kind)) end++;
    const runKey = keyOf(blocks[i], i);
    const finalIdx = end - 1;
    const final = blocks[finalIdx];
    const work = [];
    const pinned = [];
    for (let k = i; k < finalIdx; k++) {
      if (isPinned(blocks[k])) pinned.push({ kind: "block", block: blocks[k], index: k });
      else work.push(blocks[k]);
    }
    const ongoing = (live && end === blocks.length) || work.some(hasRunningSubagent);
    const foldable = !ongoing && isFinalReply(final) && work.some(isAction);
    if (!foldable) {
      if (ongoing) liveRunKeys.push(runKey);
      for (let k = i; k < end; k++) items.push({ kind: "block", block: blocks[k], index: k });
      i = end;
      continue;
    }
    items.push({
      kind: "fold",
      key: "fold-" + runKey,
      runKey,
      work,
      durationMs: spanMs(i > 0 ? blocks[i - 1].ts : blocks[i].ts, final.ts),
    });
    items.push(...pinned);
    items.push({ kind: "block", block: final, index: finalIdx });
    i = end;
  }
  return { items, liveRunKeys };
}

function spanMs(start, end) {
  return start != null && end != null && end >= start ? end - start : null;
}
