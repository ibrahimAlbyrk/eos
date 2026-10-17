// Workflow runs — the pure part: folding a lane's raw progress entries into the
// canonical snapshot, and reading the record Claude Code writes for a run.
//
// claude reports a run's progress in system/task_progress.workflow_progress, a
// field the SDK does not type (seen in the bundled binary, 0.3.x). This module
// is the only reader of that shape, so a CLI change breaks here and in its
// fixture test, nowhere else. Unknown fields are dropped, unknown states read
// as running, and anything malformed leaves the snapshot as it was.

import type { WorkflowAgent, WorkflowAgentState, WorkflowRunSnapshot } from "../../../contracts/src/canonical.ts";

export const EMPTY_WORKFLOW_SNAPSHOT: WorkflowRunSnapshot = { phases: [], agents: [], logs: [] };

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const index = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);

// "start" is sent twice: once when the agent is queued (no startedAt yet), again
// when it starts. "progress" is a running agent's tool tick.
function agentState(raw: unknown, startedAt: number | undefined): WorkflowAgentState {
  switch (raw) {
    case "done": return "done";
    case "error": return "error";
    case "cancelled": return "cancelled";
    case "start": return startedAt === undefined ? "queued" : "running";
    default: return "running";
  }
}

function toAgent(e: Raw, prev: WorkflowAgent | undefined): WorkflowAgent | null {
  const i = index(e.index);
  if (i === undefined) return null;
  const startedAt = num(e.startedAt) ?? prev?.startedAt;
  const fields: Partial<WorkflowAgent> = {
    phaseIndex: index(e.phaseIndex),
    agentId: str(e.agentId),
    model: str(e.model),
    queuedAt: num(e.queuedAt),
    startedAt,
    lastProgressAt: num(e.lastProgressAt),
    durationMs: num(e.durationMs),
    lastToolName: str(e.lastToolName),
    lastToolSummary: str(e.lastToolSummary),
    promptPreview: str(e.promptPreview),
    resultPreview: str(e.resultPreview),
    tokens: num(e.tokens),
    toolCalls: num(e.toolCalls),
    error: str(e.error),
    cached: e.cached === true ? true : undefined,
  };
  const agent: WorkflowAgent = { ...prev, index: i, label: str(e.label) ?? prev?.label ?? `agent ${i}`, state: agentState(e.state, startedAt) };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) (agent as Record<string, unknown>)[k] = v;
  return agent;
}

const byIndex = <T extends { index: number }>(m: Map<number, T>): T[] => [...m.values()].sort((a, b) => a.index - b.index);

/** Folds one `workflow_progress` array into the snapshot. The lane sends the
 *  run's whole list each time, but entries are merged by index anyway, so a
 *  partial list never drops what an earlier one reported. */
export function applyWorkflowProgress(prev: WorkflowRunSnapshot, raw: unknown): WorkflowRunSnapshot {
  if (!Array.isArray(raw)) return prev;
  const phases = new Map(prev.phases.map((p) => [p.index, p]));
  const agents = new Map(prev.agents.map((a) => [a.index, a]));
  const logs: string[] = [];
  for (const e of raw) {
    if (!isObj(e)) continue;
    if (e.type === "workflow_phase") {
      const i = index(e.index);
      const title = str(e.title);
      if (i !== undefined && title) phases.set(i, { ...phases.get(i), index: i, title });
    } else if (e.type === "workflow_agent") {
      const a = toAgent(e, agents.get(index(e.index) ?? -1));
      if (a) agents.set(a.index, a);
    } else if (e.type === "workflow_log") {
      const m = str(e.message);
      if (m) logs.push(m);
    }
  }
  // Logs carry no index: a list that has any is the run's whole log so far.
  return { phases: byIndex(phases), agents: byIndex(agents), logs: logs.length ? logs : prev.logs };
}

/** A run that ended leaves its in-flight agents as they last reported — Claude
 *  Code's own record of a stopped run still has them in progress. They end with
 *  the run: done when it completed (every agent() it awaited resolved),
 *  cancelled when it was stopped or failed. */
export function settleWorkflowSnapshot(snapshot: WorkflowRunSnapshot, status: "completed" | "failed" | "stopped"): WorkflowRunSnapshot {
  const open = (a: WorkflowAgent): boolean => a.state === "running" || a.state === "queued";
  if (!snapshot.agents.some(open)) return snapshot;
  const end: WorkflowAgentState = status === "completed" ? "done" : "cancelled";
  return { ...snapshot, agents: snapshot.agents.map((a) => (open(a) ? { ...a, state: end } : a)) };
}

/** A run's record (<session>/workflows/<runId>.json), as far as the view uses it. */
export interface WorkflowRecord {
  phases: { title: string; detail?: string }[];
  logs: string[];
  progress: unknown;
}

export function parseWorkflowRecord(json: string): WorkflowRecord | null {
  let o: unknown;
  try { o = JSON.parse(json); } catch { return null; }
  if (!isObj(o)) return null;
  const phases = Array.isArray(o.phases)
    ? o.phases.filter(isObj).map((p) => ({ title: str(p.title) ?? "", ...(str(p.detail) ? { detail: str(p.detail) } : {}) }))
    : [];
  const logs = Array.isArray(o.logs) ? o.logs.filter((l): l is string => typeof l === "string") : [];
  return { phases, logs, progress: o.workflowProgress };
}

/** The snapshot with what only the record knows: each phase's detail and the
 *  script's logs. The record's own progress fills in a run the lane never
 *  reported on (a reload after the daemon lost its memory of it). */
export function withWorkflowRecord(snapshot: WorkflowRunSnapshot, record: WorkflowRecord): WorkflowRunSnapshot {
  const base = snapshot.agents.length ? snapshot : applyWorkflowProgress(snapshot, record.progress);
  const phases = new Map(base.phases.map((p) => [p.index, p]));
  record.phases.forEach((p, i) => {
    const cur = phases.get(i + 1);
    const title = cur?.title ?? p.title;
    if (title) phases.set(i + 1, { index: i + 1, title, ...(p.detail ? { detail: p.detail } : cur?.detail ? { detail: cur.detail } : {}) });
  });
  return { phases: byIndex(phases), agents: base.agents, logs: base.logs.length ? base.logs : record.logs };
}

// Claude Code keeps a run under the session's directory:
//   <session>/subagents/workflows/<runId>/agent-<id>.jsonl   (transcriptDir)
//   <session>/workflows/<runId>.json                          (the record)
const TRANSCRIPT_DIR_RE = /^(\/.+)\/subagents\/workflows\/(wf_[A-Za-z0-9_-]+)$/;

/** The record's path for a transcriptDir, or null when the dir isn't one. */
export function workflowRecordPath(transcriptDir: string): string | null {
  const m = TRANSCRIPT_DIR_RE.exec(transcriptDir);
  if (!m || m[1].split("/").includes("..")) return null;
  return `${m[1]}/workflows/${m[2]}.json`;
}

/** An agent's transcript inside a transcriptDir. The caller validates agentId. */
export function workflowAgentTranscriptPath(transcriptDir: string, agentId: string): string | null {
  return workflowRecordPath(transcriptDir) ? `${transcriptDir}/agent-${agentId}.jsonl` : null;
}
